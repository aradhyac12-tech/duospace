import { supabase } from "@/integrations/supabase/appClient";
import { logInfo, logWarn, newTraceId } from "@/lib/telemetry";
import { errorManager } from "@/lib/errors/errorManager";

/**
 * Hardened wrapper around `supabase.functions.invoke`.
 *
 * Root cause this addresses: every call site invoked `supabase.functions.invoke`
 * directly and surfaced whatever supabase-js threw verbatim — usually the
 * generic "Failed to send a request to the Edge Function" (a
 * `FunctionsFetchError`, thrown when the underlying `fetch()` itself fails:
 * DNS/network failure, CORS rejection, or the request hanging with no
 * timeout). That message tells the user nothing actionable and there was no
 * timeout or retry, so a single dropped packet on a mobile network looked
 * identical to a fully broken backend.
 *
 * This wrapper adds:
 *  - a hard timeout (default 15s), so a hung request fails fast for the
 *    user instead of spinning forever
 *  - one automatic retry (with backoff) for transport-level failures only —
 *    never for a function that actually ran and returned a 4xx/5xx, since
 *    those are not safe to blindly retry (e.g. a QR token single-use redeem)
 *  - best-effort parsing of the function's JSON error body, since
 *    `FunctionsHttpError.message` from supabase-js does not include it
 *  - a descriptive, user-facing message distinguishing "no network",
 *    "timed out", "server error", and "not found" cases
 *  - structured, dev-only request logging (trace id, function name, timing)
 */

export class EdgeFunctionError extends Error {
  readonly cause: "network" | "timeout" | "http" | "unknown";
  readonly status?: number;
  readonly requestId: string;
  /** Extra diagnostic detail some functions attach to their JSON error body
   *  (e.g. music-search's per-provider failure trail) — optional, most
   *  functions won't set this and every existing call site is unaffected. */
  readonly debug?: string[];
  /**
   * The function's full parsed JSON error body, when it returned one and
   * parseFunctionErrorBody could find/parse it — not just the flattened
   * `.error`/`.message`/`.detail` string used for `message` above.
   *
   * ROOT CAUSE this exists to fix: every edge function that returns a
   * structured error body (e.g. finalize-upload's
   * `{ ok:false, code:"MISSING_CHUNKS", missingChunks:[0], retryable:true }`)
   * had that structure thrown away — invokeEdgeFunction always THROWS on any
   * non-2xx response rather than returning the parsed body, so callers never
   * actually got the `result.ok === false` shape their own code was written
   * to branch on (see resumableUpload.ts's now-removed dead branch). The
   * only thing that survived onto the thrown error was a flattened string
   * (`message`), which resumableUpload.ts was then forced to regex-parse
   * chunk indices back out of — fragile, and silently stops working the
   * moment a function's wording changes or parseFunctionErrorBody can't
   * locate the response body for a given supabase-js version's error shape.
   * Attaching the actual parsed object lets a caller read `err.responseBody`
   * directly and type-check it, no string-parsing required.
   */
  readonly responseBody?: unknown;

  constructor(message: string, cause: "network" | "timeout" | "http" | "unknown", requestId: string, status?: number, debug?: string[], responseBody?: unknown) {
    super(message);
    this.name = "EdgeFunctionError";
    this.cause = cause;
    this.status = status;
    this.requestId = requestId;
    this.debug = debug;
    this.responseBody = responseBody;
  }
}

interface InvokeOptions {
  body?: unknown;
  headers?: Record<string, string>;
  /** Milliseconds before the call is aborted. Default 15000. */
  timeoutMs?: number;
  /** Retry once on network/timeout failure. Default true. */
  retry?: boolean;
}

/**
 * supabase-js has shipped two different shapes for `FunctionsHttpError.context`:
 * older versions wrap the fetch Response as `{ response: Response }`, newer
 * ones set `context` to the `Response` itself. The old code only handled the
 * wrapped shape, so on current supabase-js the function's JSON body was never
 * read and every failure surfaced as the useless generic
 * "Edge Function returned a non-2xx status code".
 */
function getErrorResponse(error: unknown): Response | null {
  const ctx = (error as { context?: unknown })?.context as
    | { response?: Response; status?: number; text?: unknown }
    | undefined;
  if (!ctx) return null;
  if (typeof (ctx as { text?: unknown }).text === "function") return ctx as unknown as Response;
  if (ctx.response && typeof ctx.response.text === "function") return ctx.response;
  return null;
}

function getErrorStatus(error: unknown): number | undefined {
  return getErrorResponse(error)?.status ?? (error as { status?: number })?.status;
}

async function parseFunctionErrorBody(error: unknown): Promise<{ message: string | null; debug?: string[]; body?: unknown }> {
  const response = getErrorResponse(error);
  if (!response) return { message: null };
  try {
    const text = await response.clone().text();
    if (!text) return { message: null };
    try {
      const parsed = JSON.parse(text) as { error?: string; message?: string; detail?: string; debug?: string[] };
      const message = parsed.error || parsed.message || parsed.detail || text.slice(0, 300);
      return { message, debug: Array.isArray(parsed.debug) ? parsed.debug : undefined, body: parsed };
    } catch {
      return { message: text.slice(0, 300) };
    }
  } catch {
    return { message: null };
  }
}


function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || /abort/i.test(e.message));
}

function isNetworkError(e: unknown): boolean {
  if (!e) return false;
  const name = (e as { name?: string }).name;
  const message = (e as { message?: string }).message ?? "";
  return (
    name === "FunctionsFetchError" ||
    /failed to fetch|network|load failed|failed to send a request/i.test(message)
  );
}

/**
 * Invoke a Supabase Edge Function with timeout, one retry on transport
 * failure, and a descriptive error on failure. Throws `EdgeFunctionError`
 * (never the raw supabase-js error) so every caller can show the same
 * quality of message.
 */
export async function invokeEdgeFunction<T = unknown>(
  name: string,
  options: InvokeOptions = {},
): Promise<T> {
  const { body, headers, timeoutMs = 15000, retry = true } = options;
  const requestId = newTraceId("edgefn");
  const attempt = async (attemptNum: number): Promise<T> => {
    const startedAt = performance.now();
    // supabase-js's functions.invoke() does not reliably accept an
    // AbortSignal across SDK versions, so the timeout is implemented by
    // racing the invoke() promise against a timer instead of trying to
    // cancel the underlying fetch. The in-flight request may still complete
    // in the background, but the UI stops waiting and shows a clear message.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(Object.assign(new Error("timeout"), { name: "AbortError" }));
      }, timeoutMs);
    });

    try {
      const { data, error } = await Promise.race([
        supabase.functions.invoke<T>(name, { body, headers }),
        timeoutPromise,
      ]);
      const ms = Math.round(performance.now() - startedAt);

      if (error) {
        const { message: detail, debug, body } = await parseFunctionErrorBody(error);
        const status = getErrorStatus(error);

        if (isNetworkError(error)) {
          logWarn("edgefn", `${name} network failure`, { requestId, attemptNum, ms }, requestId);
          errorManager.capture("DS-NET-003", { component: "edgeFunction", action: name, cause: error, details: { requestId, attemptNum } });
          throw new EdgeFunctionError(
            `The "${name}" server function isn't reachable. It may not be deployed yet, or your connection dropped. Try again in a moment.`,
            "network",
            requestId,
          );
        }

        logWarn("edgefn", `${name} returned an error`, { requestId, attemptNum, status, detail }, requestId);
        if (status === 404 || /not found|requested function was not found/i.test(detail ?? error.message ?? "")) {
          errorManager.capture("DS-API-011", { component: "edgeFunction", action: name, cause: error, details: { requestId, status } });
          throw new EdgeFunctionError(
            `The "${name}" server function is not deployed in this Supabase project yet. Deploy it to project jzlpelxwzjjpddqcrtpu and try again.`,
            "http",
            requestId,
            status,
          );
        }
        errorManager.capture("DS-API-001", { component: "edgeFunction", action: name, cause: error, details: { requestId, status, detail } });
        // supabase-js's own message for any non-2xx is the unhelpful
        // "Edge Function returned a non-2xx status code" — never show it.
        const generic = /non-2xx status code/i.test(error.message ?? "");
        const fallback =
          status === 401 || status === 403
            ? "Your session expired. Sign in again and retry."
            : status === 402
              ? "No Daily.co API key is configured. Add one in Settings → Calls, or ask your partner to add theirs."
              : status === 429
                ? "Too many attempts. Please wait a minute and try again."
                : status && status >= 500
                  ? "The server hit an error handling this request. Please try again."
                  : "The server rejected the request.";
        throw new EdgeFunctionError(
          detail || (generic ? fallback : error.message) || fallback,
          "http",
          requestId,
          status,
          debug,
          body,
        );

      }

      logInfo("edgefn", `${name} ok`, { requestId, attemptNum, ms }, requestId);
      return data as T;
    } catch (e: unknown) {
      if (e instanceof EdgeFunctionError) throw e;
      if (isAbortError(e)) {
        errorManager.capture("DS-NET-002", { component: "edgeFunction", action: name, cause: e, details: { requestId } });
        throw new EdgeFunctionError(
          "The request took too long to respond. Please check your connection and try again.",
          "timeout",
          requestId,
        );
      }
      if (isNetworkError(e)) {
        errorManager.capture("DS-NET-003", { component: "edgeFunction", action: name, cause: e, details: { requestId } });
        throw new EdgeFunctionError(
          `The "${name}" server function isn't reachable. It may not be deployed to this Supabase project yet, or CORS is blocking this app origin. Deploy the function and allow this preview/published URL, then try again.`,
          "network",
          requestId,
        );
      }
      throw new EdgeFunctionError(
        e instanceof Error ? e.message : "Something went wrong. Please try again.",
        "unknown",
        requestId,
      );
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  };

  try {
    return await attempt(1);
  } catch (e) {
    // Only retry transport-level failures — never a real HTTP error, since
    // some functions (e.g. single-use QR redemption) are not idempotent.
    const retryable = retry && e instanceof EdgeFunctionError && (e.cause === "network" || e.cause === "timeout");
    if (!retryable) throw e;
    logWarn("edgefn", `${name} retrying after transport failure`, { requestId }, requestId);
    await new Promise((r) => window.setTimeout(r, 600));
    return attempt(2);
  }
}

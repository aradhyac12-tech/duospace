import { supabase } from "@/integrations/supabase/client";
import { logInfo, logWarn, newTraceId } from "@/lib/telemetry";

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

  constructor(message: string, cause: "network" | "timeout" | "http" | "unknown", requestId: string, status?: number) {
    super(message);
    this.name = "EdgeFunctionError";
    this.cause = cause;
    this.status = status;
    this.requestId = requestId;
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

async function parseFunctionErrorBody(error: unknown): Promise<string | null> {
  const ctx = (error as { context?: { response?: Response } })?.context;
  if (!ctx?.response) return null;
  try {
    const text = await ctx.response.clone().text();
    if (!text) return null;
    try {
      const parsed = JSON.parse(text) as { error?: string; message?: string };
      return parsed.error || parsed.message || text.slice(0, 300);
    } catch {
      return text.slice(0, 300);
    }
  } catch {
    return null;
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
        const detail = await parseFunctionErrorBody(error);
        const status = (error as { context?: { response?: Response } })?.context?.response?.status;

        if (isNetworkError(error)) {
          logWarn("edgefn", `${name} network failure`, { requestId, attemptNum, ms }, requestId);
          throw new EdgeFunctionError(
            `The "${name}" server function isn't reachable. It may not be deployed yet, or your connection dropped. Try again in a moment.`,
            "network",
            requestId,
          );
        }

        logWarn("edgefn", `${name} returned an error`, { requestId, attemptNum, status, detail }, requestId);
        if (status === 404 || /not found|requested function was not found/i.test(detail ?? error.message ?? "")) {
          throw new EdgeFunctionError(
            `The "${name}" server function is not deployed in this Supabase project yet. Deploy it to project jzlpelxwzjjpddqcrtpu and try again.`,
            "http",
            requestId,
            status,
          );
        }
        throw new EdgeFunctionError(
          detail || error.message || "The server rejected the request.",
          "http",
          requestId,
          status,
        );
      }

      logInfo("edgefn", `${name} ok`, { requestId, attemptNum, ms }, requestId);
      return data as T;
    } catch (e: unknown) {
      if (e instanceof EdgeFunctionError) throw e;
      if (isAbortError(e)) {
        throw new EdgeFunctionError(
          "The request took too long to respond. Please check your connection and try again.",
          "timeout",
          requestId,
        );
      }
      if (isNetworkError(e)) {
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

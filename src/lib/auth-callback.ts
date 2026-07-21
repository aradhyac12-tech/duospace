import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { logInfo, logError, newTraceId } from "@/lib/telemetry";

export interface AuthCallbackResult {
  session: Session | null;
  type: string | null;
}

export function parseAuthCallbackUrl(rawUrl: string = window.location.href) {
  const url = new URL(rawUrl, window.location.origin);
  const query = url.searchParams;
  const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
  const get = (key: string) => query.get(key) ?? hash.get(key);
  return { url, query, hash, get };
}

export function hasAuthCallback(rawUrl: string = window.location.href): boolean {
  const { get } = parseAuthCallbackUrl(rawUrl);
  return Boolean(
    get("code") ||
    get("access_token") ||
    get("refresh_token") ||
    get("error") ||
    get("error_description") ||
    get("type"),
  );
}

/** Truncate secrets in logs — we only ever record the prefix for correlation. */
const preview = (v: string | null, keep = 6) =>
  v ? `${v.slice(0, keep)}…(${v.length})` : null;

export async function completeAuthCallback(
  rawUrl: string = window.location.href,
  parentTraceId?: string,
): Promise<AuthCallbackResult> {
  const traceId = parentTraceId ?? newTraceId("cb_exchange");
  const { url, get } = parseAuthCallbackUrl(rawUrl);

  const error = get("error");
  const errorDescription = get("error_description");
  const type = get("type");
  const code = get("code");
  const accessToken = get("access_token");
  const refreshToken = get("refresh_token");

  logInfo("auth.callback", "parsed callback url", {
    request_id: traceId,
    scheme: url.protocol.replace(":", ""),
    host: url.host,
    pathname: url.pathname,
    has_code: Boolean(code),
    code_preview: preview(code),
    has_access_token: Boolean(accessToken),
    has_refresh_token: Boolean(refreshToken),
    callback_type: type,
    has_error: Boolean(error || errorDescription),
  }, traceId);

  if (error || errorDescription) {
    logError("auth.callback", "provider returned error in callback", {
      request_id: traceId, error, error_description: errorDescription,
    }, traceId);
    throw new Error(errorDescription || error || "Authentication failed");
  }

  if (code) {
    const t0 = performance.now();
    logInfo("auth.callback", "exchangeCodeForSession start", {
      request_id: traceId, code_preview: preview(code),
    }, traceId);
    const { data, error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
    const duration_ms = Math.round(performance.now() - t0);
    if (exchangeError) {
      logError("auth.callback", "exchangeCodeForSession failed", {
        request_id: traceId, duration_ms,
        status: (exchangeError as { status?: number }).status,
        code: (exchangeError as { code?: string }).code,
        name: exchangeError.name,
        message: exchangeError.message,
      }, traceId);
      throw exchangeError;
    }
    logInfo("auth.callback", "exchangeCodeForSession ok", {
      request_id: traceId, duration_ms,
      has_session: Boolean(data.session),
      user_id: data.session?.user?.id ?? null,
      expires_at: data.session?.expires_at ?? null,
    }, traceId);
    return { session: data.session ?? null, type };
  }

  if (accessToken && refreshToken) {
    logInfo("auth.callback", "setSession from implicit tokens", {
      request_id: traceId,
      access_token_preview: preview(accessToken),
    }, traceId);
    const { data, error: sessionError } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    if (sessionError) {
      logError("auth.callback", "setSession failed", {
        request_id: traceId, message: sessionError.message,
      }, traceId);
      throw sessionError;
    }
    logInfo("auth.callback", "setSession ok", {
      request_id: traceId, has_session: Boolean(data.session),
      user_id: data.session?.user?.id ?? null,
    }, traceId);
    return { session: data.session ?? null, type };
  }

  logInfo("auth.callback", "no code/tokens present — falling back to getSession()", {
    request_id: traceId,
  }, traceId);
  const { data, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  return { session: data.session ?? null, type };
}

export function cleanAuthCallbackUrl(pathname: string = window.location.pathname) {
  const params = new URLSearchParams(window.location.search);
  const invite = params.get("invite");
  const next = invite ? `${pathname}?invite=${encodeURIComponent(invite)}` : pathname;
  window.history.replaceState({}, "", next);
}

export function getPostAuthPath(rawUrl: string = window.location.href): string {
  const { get } = parseAuthCallbackUrl(rawUrl);
  const invite = get("invite") || sessionStorage.getItem("duo-pending-invite");
  if (invite) return `/settings?invite=${encodeURIComponent(invite)}`;
  return "/chat";
}

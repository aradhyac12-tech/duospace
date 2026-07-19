import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

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

export async function completeAuthCallback(rawUrl: string = window.location.href): Promise<AuthCallbackResult> {
  const { get } = parseAuthCallbackUrl(rawUrl);
  const error = get("error");
  const errorDescription = get("error_description");
  if (error || errorDescription) {
    throw new Error(errorDescription || error || "Authentication failed");
  }

  const type = get("type");
  const code = get("code");
  if (code) {
    const { data, error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
    if (exchangeError) throw exchangeError;
    return { session: data.session ?? null, type };
  }

  const accessToken = get("access_token");
  const refreshToken = get("refresh_token");
  if (accessToken && refreshToken) {
    const { data, error: sessionError } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    if (sessionError) throw sessionError;
    return { session: data.session ?? null, type };
  }

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
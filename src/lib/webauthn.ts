// Thin client wrappers around @simplewebauthn/browser + our edge functions.
import { startRegistration, startAuthentication } from "@simplewebauthn/browser";
import type { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

// supabase.functions.invoke wraps non-2xx as FunctionsHttpError whose
// `.message` is the useless string "Edge Function returned a non-2xx status
// code". The real error text lives in `context.response` — try to pull it
// so toasts show something actionable.
async function extractInvokeError(error: unknown, fallback: string): Promise<string> {
  const err = error as FunctionsHttpError & { context?: { response?: Response } };
  const resp = err?.context?.response;
  if (resp && typeof resp.clone === "function") {
    try {
      const cloned = resp.clone();
      const bodyText = await cloned.text();
      if (bodyText) {
        try {
          const parsed = JSON.parse(bodyText);
          if (parsed?.error) return String(parsed.error);
          if (parsed?.message) return String(parsed.message);
        } catch { /* not JSON */ }
        return bodyText.slice(0, 240);
      }
    } catch { /* ignore */ }
  }
  const msg = (error as { message?: string })?.message;
  return msg && msg !== "Edge Function returned a non-2xx status code"
    ? msg
    : fallback;
}

export async function registerPasskey(deviceName?: string): Promise<{
  verified: boolean; credential_id?: string;
}> {
  // Passkey enrollment must run in a top-level browsing context; iframes
  // without `allow="publickey-credentials-create"` cannot create keys.
  if (isEmbeddedInIframe()) {
    throw new Error(
      "Passkeys can't be created inside the preview iframe. Open the app in a new tab and try again.",
    );
  }

  const { data: options, error } = await supabase.functions.invoke(
    "webauthn-register-options",
    { body: {} },
  );
  if (error) throw new Error(await extractInvokeError(error, "Couldn't start passkey enrollment"));
  if (options?.error) throw new Error(options.error);

  const attResp = await startRegistration({ optionsJSON: options });

  const { data: verify, error: vErr } = await supabase.functions.invoke(
    "webauthn-register-verify",
    { body: { response: attResp, device_name: deviceName } },
  );
  if (vErr) throw new Error(await extractInvokeError(vErr, "Couldn't verify passkey"));
  if (verify?.error) throw new Error(verify.error);
  return verify;
}

export async function loginWithPasskey(email?: string): Promise<void> {
  // Passkey sign-in also requires publickey-credentials-get, which is not
  // delegated to the Lovable preview iframe.
  if (isEmbeddedInIframe()) {
    throw new Error(
      "Passkeys can't be used inside the preview iframe. Open the app in a new tab and try again.",
    );
  }

  const { data: options, error } = await supabase.functions.invoke(
    "webauthn-login-options",
    { body: email ? { email } : {} },
  );
  if (error) throw new Error(await extractInvokeError(error, "Couldn't start passkey sign-in"));
  if (options?.error) throw new Error(options.error);

  const assertion = await startAuthentication({ optionsJSON: options });

  const { data, error: vErr } = await supabase.functions.invoke(
    "webauthn-login-verify",
    { body: { response: assertion } },
  );
  if (vErr) throw new Error(await extractInvokeError(vErr, "Passkey verification failed"));
  if (data?.error) throw new Error(data.error);
  if (!data?.access_token || !data?.refresh_token) throw new Error("No session returned");

  const { error: sessErr } = await supabase.auth.setSession({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
  });
  if (sessErr) throw new Error(sessErr.message);
}

export function passkeysSupported(): boolean {
  return typeof window !== "undefined"
    && typeof window.PublicKeyCredential !== "undefined";
}

/**
 * True when the app is running inside a cross-origin iframe that hasn't been
 * granted `publickey-credentials-get`/`publickey-credentials-create` via
 * Permissions Policy — i.e. the Lovable preview shell.
 * On published `*.lovable.app` domains and custom domains this returns false
 * because the app is top-level.
 */
export function isEmbeddedInIframe(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.top !== window.self;
  } catch {
    // Cross-origin access threw — we're definitely embedded.
    return true;
  }
}

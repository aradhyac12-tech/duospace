// Thin client wrappers around @simplewebauthn/browser + our edge functions.
import { startRegistration, startAuthentication } from "@simplewebauthn/browser";
import { supabase } from "@/integrations/supabase/appClient";
import { invokeEdgeFunction, EdgeFunctionError } from "@/lib/edgeFunction";

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof EdgeFunctionError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
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

  let options: any;
  try {
    options = await invokeEdgeFunction("webauthn-register-options", { body: {} });
  } catch (err) {
    throw new Error(messageOf(err, "Couldn't start passkey enrollment"));
  }
  if (options?.error) throw new Error(options.error);

  const attResp = await startRegistration({ optionsJSON: options });

  let verify: any;
  try {
    verify = await invokeEdgeFunction("webauthn-register-verify", {
      body: { response: attResp, device_name: deviceName },
      retry: false, // registration ceremony response is single-use
    });
  } catch (err) {
    throw new Error(messageOf(err, "Couldn't verify passkey"));
  }
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

  let options: any;
  try {
    options = await invokeEdgeFunction("webauthn-login-options", { body: email ? { email } : {} });
  } catch (err) {
    throw new Error(messageOf(err, "Couldn't start passkey sign-in"));
  }
  if (options?.error) throw new Error(options.error);

  const assertion = await startAuthentication({ optionsJSON: options });

  let data: any;
  try {
    data = await invokeEdgeFunction("webauthn-login-verify", {
      body: { response: assertion },
      retry: false, // authentication assertion is single-use
    });
  } catch (err) {
    throw new Error(messageOf(err, "Passkey verification failed"));
  }
  if (data?.error) throw new Error(data.error);
  if (!data?.access_token || !data?.refresh_token) throw new Error("No session returned");

  const { error: sessErr } = await supabase.auth.setSession({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
  });
  if (sessErr) throw new Error(sessErr.message);
}

export function passkeysSupported(): boolean {
  // NOTE (found while investigating "passkey missing on APK"): this checks
  // for the browser's own PublicKeyCredential API — it does NOT and can't
  // guarantee passkeys will actually work. Two separate things both have
  // to be true for a passkey ceremony to succeed inside this Capacitor
  // app, neither of which this function can see:
  //  1. The device's Android System WebView (Capacitor's Android view is
  //     genuinely Chromium-based, but relies on the OS-updated WebView
  //     package) needs to be recent enough to expose this API at all —
  //     on an older/un-updated WebView, `window.PublicKeyCredential` is
  //     legitimately undefined and this correctly returns false. That's
  //     a real device-capability gap, not a bug to work around here.
  //  2. Even when this returns true, the actual ceremony will fail
  //     unless the app is served from a real domain the relying-party ID
  //     matches — see the WEBAUTHN_RP_ID fix in
  //     supabase/functions/_shared/webauthnOrigin.ts and its comment for
  //     what that requires (capacitor.config.json's `server.hostname`
  //     pointed at the real domain, plus Android/iOS app-domain
  //     association files hosted there). No client-side check can detect
  //     that in advance; it will surface as a specific error from
  //     loginWithPasskey/registerPasskey once WEBAUTHN_RP_ID is set.
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

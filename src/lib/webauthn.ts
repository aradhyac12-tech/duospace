// Thin client wrappers around @simplewebauthn/browser + our edge functions.
import { startRegistration, startAuthentication } from "@simplewebauthn/browser";
import { supabase } from "@/integrations/supabase/client";
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

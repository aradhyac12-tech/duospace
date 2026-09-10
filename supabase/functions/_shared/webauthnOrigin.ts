// Shared helper: derive the effective WebAuthn RP ID and expected origins
// from a request. Falls back to WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN env vars,
// then to the request's Origin header. This lets the same edge function
// work across preview URLs, published URLs, and custom domains without
// having to redeploy every time the host changes.

// BUG FIX (found while investigating "passkey missing/broken on APK"):
// this used to fall back to the REQUEST's Origin/Referer header with no
// further check. A Capacitor app's WebView serves pages from a synthetic
// local origin — `https://localhost` on Android, `capacitor://localhost`
// on iOS — by default (no `server.hostname` is configured in
// capacitor.config.json for this project). That meant every passkey
// registered from inside the APK/IPA got RP ID "localhost": not just
// wrong, but the SAME value every Capacitor app on the platform gets by
// default, since "localhost" is not a real, ownable domain. Two concrete
// breakages follow from that: (1) a passkey created in the app can never
// be used to sign in on the web version (real domain) or vice versa,
// defeating the entire cross-platform point of passkeys, and (2) at the
// platform level (Google Password Manager / iCloud Keychain), the
// relying-party prompt would show "localhost wants to use your passkey"
// — indistinguishable from any other app doing the same thing, not a
// trust signal a real security feature should ever produce.
// Loopback/local-only hostnames are now explicitly rejected as an RP ID
// source — if WEBAUTHN_RP_ID isn't set AND the request didn't come from a
// real registrable domain, this throws instead of silently minting a
// broken "localhost" identity. This will surface as passkey registration/
// login failing loudly with a clear message until WEBAUTHN_RP_ID is set
// in Supabase secrets to the app's real domain — a config step, not
// something a code change can complete on its own (see the accompanying
// note on why passkeys need `capacitor.config.json`'s `server.hostname`
// pointed at that same real domain, with Android/iOS app-domain
// association files hosted there, to work from inside the native app at
// all — no amount of client or edge-function code substitutes for that).
const isLoopbackOrLocal = (host: string): boolean =>
  host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";

export function getWebauthnConfig(req: Request): {
  rpID: string;
  origins: string[];
} {
  const envRpId = Deno.env.get("WEBAUTHN_RP_ID")?.trim();
  const envOrigins = (Deno.env.get("WEBAUTHN_ORIGIN") ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);

  const originHeader = req.headers.get("origin") ?? req.headers.get("referer") ?? "";
  let hostFromReq: string | null = null;
  let originFromReq: string | null = null;
  try {
    if (originHeader) {
      const u = new URL(originHeader);
      hostFromReq = u.hostname; // no port, no protocol — WebAuthn RP ID
      originFromReq = `${u.protocol}//${u.host}`;
    }
  } catch { /* ignore */ }

  // Build origin allow-list. Always accept whatever env says, plus the
  // request origin so preview iframes and popped-out tabs both work.
  const origins = Array.from(new Set([
    ...envOrigins,
    ...(originFromReq ? [originFromReq] : []),
    "http://localhost:8080",
  ]));

  if (envRpId) return { rpID: envRpId, origins };

  if (hostFromReq && !isLoopbackOrLocal(hostFromReq)) {
    return { rpID: hostFromReq, origins };
  }

  throw new Error(
    "WebAuthn is not configured: no WEBAUTHN_RP_ID secret is set, and the " +
    "request didn't come from a real domain (it looks like a local/native " +
    "app origin, which can never be a valid relying-party ID). Set the " +
    "WEBAUTHN_RP_ID secret in Supabase to the app's real domain (e.g. " +
    "\"duospace.app\") to enable passkeys.",
  );
}

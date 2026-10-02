// Shared helper: derive the effective WebAuthn RP ID and the set of accepted
// clientDataJSON origins for a request.
//
// RP ID
//   1. WEBAUTHN_RP_ID secret (required for the native apps — see below)
//   2. otherwise the request's Origin/Referer host, if it is a real domain
//
// Accepted origins (exact-match against clientDataJSON.origin)
//   - WEBAUTHN_ORIGIN            comma-separated extra https origins
//   - https://<rpID>             the web app / iOS 17.4+ native passkeys
//   - android:apk-key-hash:...   derived from WEBAUTHN_ANDROID_CERT_SHA256
//                                (the same SHA-256 signing-cert fingerprints
//                                 that go into assetlinks.json), or given
//                                 directly via WEBAUTHN_ANDROID_ORIGINS
//   - the request origin, but only if its host is the RP ID or a subdomain
//
// WHY THIS CHANGED: the Capacitor WebView serves the app from a synthetic
// origin (https://localhost on Android, capacitor://localhost on iOS). The old
// code echoed the request origin into the allow-list and, with no
// WEBAUTHN_RP_ID, either minted an RP ID of "localhost" or (after a later
// patch) threw. Native passkeys are now performed by the OS credential APIs
// through @capgo/capacitor-passkey, which use the real RP ID and, on Android,
// report an `android:apk-key-hash:<b64url sha256>` origin — so both the RP ID
// and that Android origin must come from configuration, never from the
// (attacker-controllable) request headers.

const isLoopbackOrLocal = (host: string): boolean =>
  host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";

const csv = (v: string | undefined): string[] =>
  (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** "AA:BB:..:FF" (or bare hex) SHA-256 cert fingerprint -> Android app origin. */
export function androidOriginFromFingerprint(fp: string): string | null {
  const hex = fp.replace(/[^0-9a-fA-F]/g, "");
  if (hex.length !== 64) return null;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return `android:apk-key-hash:${toBase64Url(bytes)}`;
}

function androidOrigins(): string[] {
  const direct = csv(Deno.env.get("WEBAUTHN_ANDROID_ORIGINS"));
  const derived = csv(Deno.env.get("WEBAUTHN_ANDROID_CERT_SHA256"))
    .map(androidOriginFromFingerprint)
    .filter((o): o is string => !!o);
  return [...direct, ...derived];
}

export function getWebauthnConfig(req: Request): {
  rpID: string;
  origins: string[];
} {
  const envRpId = Deno.env.get("WEBAUTHN_RP_ID")?.trim();

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

  let rpID: string;
  if (envRpId) {
    rpID = envRpId;
  } else if (hostFromReq && !isLoopbackOrLocal(hostFromReq)) {
    rpID = hostFromReq;
  } else {
    throw new Error(
      "Passkeys aren't configured on the server: set the WEBAUTHN_RP_ID secret " +
      "in Supabase to the app's real domain (e.g. \"duospace.app\"). The native " +
      "apps can't supply it themselves — their request origin is a local one.",
    );
  }

  const requestOriginOk = !!hostFromReq &&
    (hostFromReq === rpID || hostFromReq.endsWith(`.${rpID}`));

  const origins = Array.from(new Set([
    ...csv(Deno.env.get("WEBAUTHN_ORIGIN")),
    `https://${rpID}`,
    ...androidOrigins(),
    ...(requestOriginOk && originFromReq ? [originFromReq] : []),
  ]));

  return { rpID, origins };
}

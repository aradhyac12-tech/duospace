// APNs provider-token authentication (RFC 7519 JWT, ES256) — mirrors the
// structure of firebaseAuth.ts but for Apple's HTTP/2 Provider API instead
// of Firebase's OAuth2 service-account flow.
//
// Reads credentials exclusively from Supabase secrets:
//   APNS_TEAM_ID, APNS_KEY_ID, APNS_PRIVATE_KEY, APNS_BUNDLE_ID,
//   APNS_ENVIRONMENT ("sandbox" | "production")
// Never hardcode credentials. Missing/malformed secrets throw an
// `ApnsConfigError` and the caller must surface a clear 500 without leaking
// the private key, key id, or team id in the response body.
//
// Apple allows a provider token to be reused for up to 60 minutes and
// recommends not generating a new one more than once every 20 minutes.
// This module is deliberately more conservative than that ceiling — it
// signs a 10-minute token and refreshes it a little before expiry — so a
// stale/rotated key is caught quickly without hammering nothing (token
// generation is local, it costs no network call, only a cheap ECDSA sign).

const APNS_JWT_TTL_SECONDS = 600; // 10 minutes, per this project's requirement
const REFRESH_SKEW_SECONDS = 60; // reuse until <60s of life remains

export class ApnsConfigError extends Error {}

export interface ApnsEnv {
  teamId: string;
  keyId: string;
  privateKey: string;
  bundleId: string;
  environment: "sandbox" | "production";
}

interface CachedJwt {
  token: string;
  expiresAtMs: number;
  keyId: string;
}

// Module-scope cache: Supabase Edge Runtime reuses warm isolates across
// invocations, so caching here avoids re-signing a JWT on every single
// push send. Never logged, never returned to any caller.
let cached: CachedJwt | null = null;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeString(s: string): string {
  return base64UrlEncode(new TextEncoder().encode(s));
}

/** Converts a PEM-encoded PKCS#8 EC private key (the .p8 APNs auth key) into a CryptoKey for ES256 signing. */
async function importApnsPrivateKey(pem: string): Promise<CryptoKey> {
  const normalized = pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
  const pemBody = normalized
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");

  if (!pemBody) {
    throw new ApnsConfigError("APNS_PRIVATE_KEY is empty or malformed after stripping PEM headers");
  }

  const binaryDer = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  return crypto.subtle.importKey(
    "pkcs8",
    binaryDer.buffer,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

/** DER-encoded ECDSA signature (what crypto.subtle produces for named curves in some runtimes)
 *  vs raw r||s (what JOSE/JWT ES256 requires) — Deno's WebCrypto returns raw r||s directly for
 *  ECDSA with P-256, so no conversion is needed here. Kept as a single seam in case that ever
 *  changes, rather than assuming it silently at every call site. */
function ensureRawEcdsaSignature(sig: ArrayBuffer): Uint8Array {
  const bytes = new Uint8Array(sig);
  if (bytes.length === 64) return bytes; // already raw r(32)||s(32) for P-256
  throw new Error(`Unexpected ECDSA signature length ${bytes.length}, expected 64 (raw r||s for P-256)`);
}

export function readApnsEnv(): ApnsEnv {
  const teamId = Deno.env.get("APNS_TEAM_ID");
  const keyId = Deno.env.get("APNS_KEY_ID");
  const privateKey = Deno.env.get("APNS_PRIVATE_KEY");
  const bundleId = Deno.env.get("APNS_BUNDLE_ID");
  const environmentRaw = Deno.env.get("APNS_ENVIRONMENT");

  const missing: string[] = [];
  if (!teamId) missing.push("APNS_TEAM_ID");
  if (!keyId) missing.push("APNS_KEY_ID");
  if (!privateKey) missing.push("APNS_PRIVATE_KEY");
  if (!bundleId) missing.push("APNS_BUNDLE_ID");
  if (!environmentRaw) missing.push("APNS_ENVIRONMENT");
  if (missing.length > 0) {
    throw new ApnsConfigError(
      `Missing required Supabase secret(s): ${missing.join(", ")}. Set them with \`supabase secrets set\` — see docs/IOS_NATIVE_SETUP.md.`,
    );
  }
  if (environmentRaw !== "sandbox" && environmentRaw !== "production") {
    throw new ApnsConfigError(`APNS_ENVIRONMENT must be "sandbox" or "production", got "${environmentRaw}"`);
  }

  return { teamId: teamId!, keyId: keyId!, privateKey: privateKey!, bundleId: bundleId!, environment: environmentRaw };
}

async function signApnsJwt(env: ApnsEnv): Promise<{ token: string; expiresAtMs: number }> {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: env.keyId };
  const claims = { iss: env.teamId, iat: nowSec };

  const unsigned = `${base64UrlEncodeString(JSON.stringify(header))}.${base64UrlEncodeString(JSON.stringify(claims))}`;
  const key = await importApnsPrivateKey(env.privateKey);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(unsigned),
  );
  const raw = ensureRawEcdsaSignature(signature);
  return {
    token: `${unsigned}.${base64UrlEncode(raw)}`,
    expiresAtMs: (nowSec + APNS_JWT_TTL_SECONDS) * 1000,
  };
}

/**
 * Returns a valid APNs provider JWT, reusing the cached one when it still
 * has more than REFRESH_SKEW_SECONDS of life left and the key id hasn't
 * changed (covers a mid-flight secret rotation), otherwise signing a fresh
 * one. Also returns the resolved ApnsEnv so callers don't have to read env
 * vars twice.
 */
export async function getApnsProviderToken(): Promise<{ token: string; env: ApnsEnv }> {
  const env = readApnsEnv();

  if (cached && cached.keyId === env.keyId && cached.expiresAtMs - Date.now() > REFRESH_SKEW_SECONDS * 1000) {
    return { token: cached.token, env };
  }

  const { token, expiresAtMs } = await signApnsJwt(env);
  cached = { token, expiresAtMs, keyId: env.keyId };
  return { token, env };
}

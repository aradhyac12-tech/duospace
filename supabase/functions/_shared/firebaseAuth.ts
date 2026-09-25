// OAuth2 access-token helper for the Firebase Cloud Messaging HTTP v1 API.
//
// Reads the service account exclusively from Supabase Secrets:
//   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
// Never hardcode credentials — if any of these are missing this module
// throws a `FirebaseConfigError` and the caller must surface a clear 500
// without leaking the private key or client email in the response body.

const TOKEN_URI = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

export class FirebaseConfigError extends Error {}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

// Module-scope cache: Deno Deploy / Supabase Edge Runtime reuses isolates
// across invocations when warm, so caching here meaningfully cuts latency
// and avoids hammering Google's token endpoint. Never logged, never
// returned to any caller.
let cachedToken: CachedToken | null = null;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeString(s: string): string {
  return base64UrlEncode(new TextEncoder().encode(s));
}

/** Converts a PEM-encoded PKCS#8 private key into a CryptoKey for RS256 signing. */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const normalized = pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
  const pemBody = normalized
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");

  if (!pemBody) {
    throw new FirebaseConfigError("FIREBASE_PRIVATE_KEY is empty or malformed after stripping PEM headers");
  }

  const binaryDer = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  return crypto.subtle.importKey(
    "pkcs8",
    binaryDer.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

interface ServiceAccountEnv {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

export function readServiceAccountEnv(): ServiceAccountEnv {
  const projectId = Deno.env.get("FIREBASE_PROJECT_ID");
  const clientEmail = Deno.env.get("FIREBASE_CLIENT_EMAIL");
  const privateKey = Deno.env.get("FIREBASE_PRIVATE_KEY");

  const missing: string[] = [];
  if (!projectId) missing.push("FIREBASE_PROJECT_ID");
  if (!clientEmail) missing.push("FIREBASE_CLIENT_EMAIL");
  if (!privateKey) missing.push("FIREBASE_PRIVATE_KEY");
  if (missing.length > 0) {
    throw new FirebaseConfigError(
      `Missing required Supabase secret(s): ${missing.join(", ")}. Set them with \`supabase secrets set\` — see PUSH_NOTIFICATIONS.md.`,
    );
  }

  return { projectId: projectId!, clientEmail: clientEmail!, privateKey: privateKey! };
}

async function signServiceAccountJwt(env: ServiceAccountEnv): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: env.clientEmail,
    scope: SCOPE,
    aud: TOKEN_URI,
    iat: nowSec,
    exp: nowSec + 3600,
  };

  const unsigned = `${base64UrlEncodeString(JSON.stringify(header))}.${base64UrlEncodeString(JSON.stringify(claims))}`;
  const key = await importPrivateKey(env.privateKey);
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Returns a valid OAuth2 access token for the FCM HTTP v1 API, using a
 * cached token when it has more than 60s of life left, otherwise minting a
 * fresh one via the standard JWT-bearer service-account flow.
 */
export async function getAccessToken(): Promise<{ accessToken: string; projectId: string }> {
  const env = readServiceAccountEnv();

  if (cachedToken && cachedToken.expiresAtMs - Date.now() > 60_000) {
    return { accessToken: cachedToken.accessToken, projectId: env.projectId };
  }

  const assertion = await signServiceAccountJwt(env);
  const res = await fetch(TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    // Never include the assertion/private key in logs or errors.
    console.error("[firebaseAuth] token exchange failed", res.status, detail.slice(0, 300));
    throw new Error(`Firebase OAuth token exchange failed (${res.status})`);
  }

  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    accessToken: json.access_token,
    expiresAtMs: Date.now() + json.expires_in * 1000,
  };
  return { accessToken: cachedToken.accessToken, projectId: env.projectId };
}

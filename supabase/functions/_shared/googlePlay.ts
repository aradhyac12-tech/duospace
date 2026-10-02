// Shared Google Play server-side client (replaces the old stubs that lived
// inside verify-google-play-purchase/index.ts).
//
// Importing from a *function's* index.ts is unsafe — that file calls
// Deno.serve() and createClient() at module load — so both
// verify-google-play-purchase and google-play-rtdn import from here instead.
//
// Required secrets (Supabase Edge Function secrets, server-side ONLY):
//   GOOGLE_PLAY_SERVICE_ACCOUNT_JSON  full JSON key of a service account that
//                                     has "View financial data" + "Manage
//                                     orders and subscriptions" in Play Console
//   GOOGLE_PLAY_PACKAGE_NAME          optional, defaults to com.duospace.app
// For RTDN push authentication (see verifyPubSubJwt):
//   PUBSUB_PUSH_AUDIENCE              the exact audience set on the push subscription
//   PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL the service account the push subscription signs as
//
// Everything fails CLOSED: missing config or any unexpected Google response
// throws, and callers treat a throw as "grant nothing".

export interface GooglePlaySubscriptionResult {
  valid: boolean;
  orderId?: string;
  expiryTimeMillis?: string;
  subscriptionState?:
    | "active" | "canceled" | "in_grace_period" | "on_hold" | "paused" | "expired" | "pending" | "revoked";
  acknowledgementState?: "acknowledged" | "pending";
  linkedPurchaseToken?: string;
  obfuscatedExternalAccountId?: string;
  /** true when Google marks this as a license-tester (test) purchase. */
  testPurchase?: boolean;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- env / injection points (kept overridable so tests need no network) ----

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...a) => fetch(...a);
let nowImpl: () => number = () => Date.now();
let envImpl: (k: string) => string | undefined = (k) =>
  (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get(k);

/** Test hook only. */
export function __setTestHooks(h: { fetch?: Fetch; now?: () => number; env?: (k: string) => string | undefined }) {
  if (h.fetch) fetchImpl = h.fetch;
  if (h.now) nowImpl = h.now;
  if (h.env) envImpl = h.env;
  tokenCache = null;
  jwksCache = null;
}

const ANDROID_PUBLISHER = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";

function packageName(): string {
  return envImpl("GOOGLE_PLAY_PACKAGE_NAME") || "com.duospace.app";
}

// ---- base64url + PEM helpers ----

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function pemToDer(pem: string): ArrayBuffer {
  const body = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

// ---- service account -> OAuth2 access token ----

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

function loadServiceAccount(): ServiceAccount {
  const raw = envImpl("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON");
  if (!raw) throw new Error("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not configured");
  let parsed: ServiceAccount;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not valid JSON");
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is missing client_email/private_key");
  }
  return parsed;
}

let tokenCache: { token: string; expiresAtMs: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAtMs - 60_000 > nowImpl()) return tokenCache.token;

  const sa = loadServiceAccount();
  const tokenUri = sa.token_uri || "https://oauth2.googleapis.com/token";
  const iat = Math.floor(nowImpl() / 1000);
  const enc = new TextEncoder();
  const header = b64urlEncode(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = b64urlEncode(
    enc.encode(
      JSON.stringify({
        iss: sa.client_email,
        scope: "https://www.googleapis.com/auth/androidpublisher",
        aud: tokenUri,
        iat,
        exp: iat + 3600,
      }),
    ),
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(`${header}.${claims}`)));
  const assertion = `${header}.${claims}.${b64urlEncode(sig)}`;

  const res = await fetchImpl(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });
  if (!res.ok) throw new Error(`Google OAuth token exchange failed (${res.status})`);
  const json = await res.json();
  if (!json.access_token) throw new Error("Google OAuth token exchange returned no access_token");
  tokenCache = { token: json.access_token, expiresAtMs: nowImpl() + (Number(json.expires_in) || 3600) * 1000 };
  return tokenCache.token;
}

// ---- subscriptionsv2.get ----

const STATE_MAP: Record<string, NonNullable<GooglePlaySubscriptionResult["subscriptionState"]>> = {
  SUBSCRIPTION_STATE_ACTIVE: "active",
  SUBSCRIPTION_STATE_CANCELED: "canceled",
  SUBSCRIPTION_STATE_IN_GRACE_PERIOD: "in_grace_period",
  SUBSCRIPTION_STATE_ON_HOLD: "on_hold",
  SUBSCRIPTION_STATE_PAUSED: "paused",
  SUBSCRIPTION_STATE_EXPIRED: "expired",
  SUBSCRIPTION_STATE_PENDING: "pending",
  SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED: "revoked",
};

/** Pure mapper, exported for tests. `body` is Google's SubscriptionPurchaseV2. */
export function mapSubscriptionPurchaseV2(
  productId: string,
  body: Record<string, any>,
  nowMs: number,
): GooglePlaySubscriptionResult {
  const state = STATE_MAP[String(body.subscriptionState ?? "")];
  const lineItem = Array.isArray(body.lineItems)
    ? (body.lineItems as any[]).find((li) => li?.productId === productId)
    : undefined;

  const expiryMs = lineItem?.expiryTime ? Date.parse(lineItem.expiryTime) : NaN;
  const base: GooglePlaySubscriptionResult = {
    valid: false,
    orderId: body.latestOrderId,
    expiryTimeMillis: Number.isFinite(expiryMs) ? String(expiryMs) : undefined,
    subscriptionState: state,
    acknowledgementState:
      body.acknowledgementState === "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED" ? "acknowledged" : "pending",
    linkedPurchaseToken: body.linkedPurchaseToken || undefined,
    obfuscatedExternalAccountId: body.externalAccountIdentifiers?.obfuscatedExternalAccountId || undefined,
    testPurchase: body.testPurchase ? true : undefined,
  };

  // The token must actually be for the product the client claims. Without
  // this, a cheap product's token could be presented as the expensive one.
  if (!lineItem) return base;
  if (!state) return base; // unknown state -> fail closed

  const stillEntitled = Number.isFinite(expiryMs) && expiryMs > nowMs;
  // ACTIVE and IN_GRACE_PERIOD grant access. CANCELED keeps access until the
  // paid period ends. ON_HOLD / PAUSED / EXPIRED / PENDING / revoked do not.
  const grants = state === "active" || state === "in_grace_period" || state === "canceled";
  base.valid = grants && stillEntitled;
  return base;
}

async function googleFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken();
  return fetchImpl(url, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
}

export async function verifyWithGooglePlay(
  productId: string,
  purchaseToken: string,
): Promise<GooglePlaySubscriptionResult> {
  const url = `${ANDROID_PUBLISHER}/${encodeURIComponent(packageName())}/purchases/subscriptionsv2/tokens/${
    encodeURIComponent(purchaseToken)
  }`;
  const res = await googleFetch(url);

  // 404/410: Google does not know this token (forged, or too old). That is a
  // definitive "not a valid purchase", not an outage.
  if (res.status === 404 || res.status === 410) return { valid: false };
  // 400 with a malformed token is also a definitive rejection.
  if (res.status === 400) return { valid: false };
  // 401/403 = our service account isn't authorized in Play Console; 5xx = Google.
  // Both are "can't verify right now" -> throw so callers fail closed and retry.
  if (!res.ok) throw new Error(`Google Play subscriptionsv2.get failed (${res.status})`);

  return mapSubscriptionPurchaseV2(productId, await res.json(), nowImpl());
}

export async function acknowledgeWithGooglePlay(productId: string, purchaseToken: string): Promise<void> {
  // subscriptionsv2 has no acknowledge; the v3 subscriptions endpoint is the
  // supported call and is a no-op success for base-plan subscriptions that are
  // already acknowledged.
  const url = `${ANDROID_PUBLISHER}/${encodeURIComponent(packageName())}/purchases/subscriptions/${
    encodeURIComponent(productId)
  }/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`;
  const res = await googleFetch(url, { method: "POST", body: "{}" });
  if (!res.ok) throw new Error(`Google Play acknowledge failed (${res.status})`);
}

// ---- Pub/Sub push OIDC verification (RTDN) ----

let jwksCache: { keys: any[]; fetchedAtMs: number } | null = null;

async function getGoogleJwks(forceRefresh = false): Promise<any[]> {
  if (!forceRefresh && jwksCache && nowImpl() - jwksCache.fetchedAtMs < 3_600_000) return jwksCache.keys;
  const res = await fetchImpl("https://www.googleapis.com/oauth2/v3/certs");
  if (!res.ok) throw new Error(`Google JWKS fetch failed (${res.status})`);
  const json = await res.json();
  jwksCache = { keys: json.keys ?? [], fetchedAtMs: nowImpl() };
  return jwksCache.keys;
}

/**
 * Verifies the `Authorization: Bearer <OIDC JWT>` that a Pub/Sub push
 * subscription attaches: RS256 signature against Google's published keys,
 * issuer, audience, expiry, and that it was minted for OUR push service
 * account. Returns false (never throws) on anything unexpected, and false when
 * the two PUBSUB_* env vars are not configured.
 */
export async function verifyPubSubJwt(authorizationHeader: string | null): Promise<boolean> {
  try {
    const audience = envImpl("PUBSUB_PUSH_AUDIENCE");
    const expectedEmail = envImpl("PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL");
    if (!audience || !expectedEmail) return false;
    if (!authorizationHeader?.startsWith("Bearer ")) return false;

    const jwt = authorizationHeader.slice(7).trim();
    const parts = jwt.split(".");
    if (parts.length !== 3) return false;
    const [h, p, s] = parts;
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(h)));
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
    if (header.alg !== "RS256" || !header.kid) return false;

    let jwk = (await getGoogleJwks()).find((k) => k.kid === header.kid);
    if (!jwk) jwk = (await getGoogleJwks(true)).find((k) => k.kid === header.kid); // key rotation
    if (!jwk) return false;

    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlDecode(s),
      new TextEncoder().encode(`${h}.${p}`),
    );
    if (!ok) return false;

    const nowSec = Math.floor(nowImpl() / 1000);
    if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") return false;
    if (claims.aud !== audience) return false;
    if (typeof claims.exp !== "number" || claims.exp <= nowSec) return false;
    if (claims.email !== expectedEmail || claims.email_verified !== true) return false;
    return true;
  } catch {
    return false;
  }
}

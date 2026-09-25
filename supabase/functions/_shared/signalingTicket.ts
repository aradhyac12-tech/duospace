/**
 * signalingTicket — the pure minting + config logic behind the
 * `signaling-ticket` edge function, extracted so it is unit-testable
 * (src/test/signalingTicketAuthz.test.ts) without a Deno runtime or a
 * Supabase project. Uses only Web Crypto / TextEncoder / btoa, which Deno,
 * Node 18+ and browsers all provide. No Deno globals, no I/O.
 *
 * The ticket must be accepted by infrastructure/signaling/src/auth.ts
 * (verifyClientToken): HS256, `purpose: "duospace-signaling"`, `sub` = user id.
 */
export const SIGNALING_TICKET_PURPOSE = "duospace-signaling";
export const TICKET_TTL_SECONDS = 120;

function base64url(bytes: Uint8Array): string {
  let bin = "";
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacSha256(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}

export interface MintOptions {
  /** Unix seconds; defaults to now. Injectable for tests. */
  now?: number;
  jti?: string;
}

export async function mintSignalingTicket(userId: string, secret: string, opts: MintOptions = {}): Promise<string> {
  if (!secret) throw new Error("signaling ticket secret is not configured");
  if (!userId) throw new Error("userId is required");
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    sub: userId,
    purpose: SIGNALING_TICKET_PURPOSE,
    iat: now,
    exp: now + TICKET_TTL_SECONDS,
    jti: opts.jti ?? crypto.randomUUID(),
  };
  const enc = (o: unknown) => base64url(new TextEncoder().encode(JSON.stringify(o)));
  const signingInput = `${enc(header)}.${enc(payload)}`;
  return `${signingInput}.${base64url(await hmacSha256(secret, signingInput))}`;
}

/** Only a well-formed wss:// URL is ever handed to clients; anything else → null. */
export function resolvePublicSignalingUrl(raw: string | undefined | null): string | null {
  const v = (raw ?? "").trim();
  return /^wss:\/\/[a-z0-9.-]+(:\d+)?(\/[^\s]*)?$/i.test(v) ? v : null;
}

/** SIGNALING_TICKET_SECRET wins; SUPABASE_JWT_SECRET is a local-serve fallback only. */
export function resolveTicketSecret(get: (k: string) => string | undefined): string | null {
  const s = get("SIGNALING_TICKET_SECRET") || get("SUPABASE_JWT_SECRET");
  return s ? s : null;
}

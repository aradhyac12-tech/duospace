/**
 * Single-use-scope "decline from the notification" token.
 *
 * Minted by send-push into the incoming-call push; lets the native Android
 * notification's Decline button decline THIS call as THIS receiver without
 * launching the app (instant decline). It authorizes nothing else: it binds
 * callId + receiverId + expiry, and call-decline additionally requires the
 * call to still be ringing and unclaimed (same rules as decline_call()).
 *
 * Secret: CALL_ACTION_SECRET (Supabase Edge Function secret). NOT a
 * SUPABASE_-prefixed name — that prefix is reserved and never reaches
 * functions (see docs/CALLING_DEVICE_VERIFICATION.md).
 * Pure WebCrypto: runs in Deno and in vitest.
 */
const te = new TextEncoder();
const b64u = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const DECLINE_TOKEN_TTL_SECONDS = 90; // ring window (~45s) + slack for a slow tap

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, te.encode(data)));
}
const payload = (callId: string, receiverId: string, exp: number) => `decline.v1|${callId}|${receiverId}|${exp}`;

export async function mintDeclineToken(secret: string, callId: string, receiverId: string, nowSec = Math.floor(Date.now() / 1000)): Promise<{ token: string; exp: number }> {
  const exp = nowSec + DECLINE_TOKEN_TTL_SECONDS;
  return { token: await hmac(secret, payload(callId, receiverId, exp)), exp };
}

export type DeclineVerdict = { ok: true } | { ok: false; reason: "bad_request" | "expired" | "bad_signature" };

/** Constant-time comparison of equal-length strings. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function verifyDeclineToken(secret: string, p: { callId?: unknown; receiverId?: unknown; exp?: unknown; token?: unknown }, nowSec = Math.floor(Date.now() / 1000)): Promise<DeclineVerdict> {
  const uuid = /^[0-9a-f-]{36}$/i;
  if (typeof p.callId !== "string" || !uuid.test(p.callId) || typeof p.receiverId !== "string" || !uuid.test(p.receiverId)
    || typeof p.exp !== "number" || !Number.isInteger(p.exp) || typeof p.token !== "string" || p.token.length > 128) {
    return { ok: false, reason: "bad_request" };
  }
  if (p.exp < nowSec || p.exp > nowSec + DECLINE_TOKEN_TTL_SECONDS + 5) return { ok: false, reason: "expired" };
  const expected = await hmac(secret, payload(p.callId, p.receiverId, p.exp));
  return safeEqual(expected, p.token) ? { ok: true } : { ok: false, reason: "bad_signature" };
}

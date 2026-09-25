/** Instant-decline token (send-push mints, call-decline verifies). Real WebCrypto. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { mintDeclineToken, verifyDeclineToken, DECLINE_TOKEN_TTL_SECONDS } from "../../supabase/functions/_shared/callActionToken";

const S = "test-secret-0123456789abcdef0123456789abcdef";
const CALL = "11111111-1111-4111-8111-111111111111", ME = "22222222-2222-4222-8222-222222222222", OTHER = "33333333-3333-4333-8333-333333333333";
const now = 1_800_000_000;

describe("decline token", () => {
  it("valid token for this call + receiver verifies", async () => {
    const { token, exp } = await mintDeclineToken(S, CALL, ME, now);
    expect(exp).toBe(now + DECLINE_TOKEN_TTL_SECONDS);
    expect(await verifyDeclineToken(S, { callId: CALL, receiverId: ME, exp, token }, now + 5)).toEqual({ ok: true });
  });
  it("cannot be reused for another call or another user, or with a forged expiry", async () => {
    const { token, exp } = await mintDeclineToken(S, CALL, ME, now);
    expect(await verifyDeclineToken(S, { callId: OTHER, receiverId: ME, exp, token }, now)).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(await verifyDeclineToken(S, { callId: CALL, receiverId: OTHER, exp, token }, now)).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(await verifyDeclineToken(S, { callId: CALL, receiverId: ME, exp: exp - 10, token }, now)).toMatchObject({ ok: false, reason: "bad_signature" });
  });
  it("wrong secret / tampered token rejected", async () => {
    const { token, exp } = await mintDeclineToken(S, CALL, ME, now);
    expect(await verifyDeclineToken("other-secret", { callId: CALL, receiverId: ME, exp, token }, now)).toMatchObject({ ok: false });
    expect(await verifyDeclineToken(S, { callId: CALL, receiverId: ME, exp, token: (token[0] === "A" ? "B" : "A") + token.slice(1) }, now)).toMatchObject({ ok: false });
  });
  it("expired or far-future expiry rejected", async () => {
    const { token, exp } = await mintDeclineToken(S, CALL, ME, now);
    expect(await verifyDeclineToken(S, { callId: CALL, receiverId: ME, exp, token }, exp + 1)).toMatchObject({ ok: false, reason: "expired" });
    const far = await mintDeclineToken(S, CALL, ME, now + 10_000);
    expect(await verifyDeclineToken(S, { callId: CALL, receiverId: ME, exp: far.exp, token: far.token }, now)).toMatchObject({ ok: false, reason: "expired" });
  });
  it("malformed input rejected before any crypto", async () => {
    for (const bad of [{}, { callId: "x", receiverId: ME, exp: now, token: "t" }, { callId: CALL, receiverId: ME, exp: "1", token: "t" }, { callId: CALL, receiverId: ME, exp: now, token: "x".repeat(500) }]) {
      expect(await verifyDeclineToken(S, bad as never, now)).toMatchObject({ ok: false, reason: "bad_request" });
    }
  });
});

describe("wiring (static)", () => {
  const root = `${__dirname}/../..`;
  it("call-decline applies decline_call()'s exact conditions and runs without a user JWT", () => {
    const fn = readFileSync(`${root}/supabase/functions/call-decline/index.ts`, "utf8");
    for (const s of ['.eq("receiver_id"', '.eq("status", "in_progress")', '.is("claimed_by", null)', "declined_at", "verifyDeclineToken"]) expect(fn).toContain(s);
    expect(readFileSync(`${root}/supabase/config.toml`, "utf8")).toMatch(/\[functions\.call-decline\]\s*\nverify_jwt = false/);
  });
  it("the receiver is shipped and registered (non-exported) by the native patch script", () => {
    const patch = readFileSync(`${root}/scripts/patch-native-permissions.mjs`, "utf8");
    expect(patch).toContain('"CallActionReceiver.kt"');
    expect(patch).toContain('android:name=".CallActionReceiver"\\n        android:exported="false"');
  });
  it("secret uses a non-reserved name (SUPABASE_* never reaches functions)", () => {
    expect(readFileSync(`${root}/supabase/functions/call-decline/index.ts`, "utf8")).toContain('Deno.env.get("CALL_ACTION_SECRET")');
  });
});

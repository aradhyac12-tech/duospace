// @vitest-environment node
/**
 * End-to-end contract between the ticket MINTER (supabase/functions/_shared/signalingTicket.ts,
 * used by the signaling-ticket edge function) and the ticket VERIFIER
 * (infrastructure/signaling/src/auth.ts, used by the Render signaling server).
 * If these two drift, calls hang on "Connecting…" — this test fails first.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { SignJWT } from "jose";
import {
  mintSignalingTicket,
  resolvePublicSignalingUrl,
  resolveTicketSecret,
  SIGNALING_TICKET_PURPOSE,
  TICKET_TTL_SECONDS,
} from "../../supabase/functions/_shared/signalingTicket";

const SECRET = "test-secret-0123456789abcdef0123456789abcdef";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const nowSec = () => Math.floor(Date.now() / 1000);

// auth.ts caches the key on first use, so load a fresh module per secret.
async function loadVerifier(secret: string | undefined) {
  vi.resetModules();
  if (secret === undefined) delete process.env.SIGNALING_TICKET_SECRET;
  else process.env.SIGNALING_TICKET_SECRET = secret;
  delete process.env.SUPABASE_JWT_SECRET;
  return import("../../infrastructure/signaling/src/auth");
}

const decode = (t: string) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString());

describe("signaling ticket authz", () => {
  beforeEach(() => { vi.useRealTimers(); });

  it("a freshly minted ticket is accepted and yields the SAME user id", async () => {
    const { verifyClientToken } = await loadVerifier(SECRET);
    const ticket = await mintSignalingTicket(USER, SECRET);
    await expect(verifyClientToken(ticket)).resolves.toEqual({ userId: USER });
  });

  it("carries purpose, sub, a 120s lifetime and a unique jti", async () => {
    const now = nowSec();
    const a = decode(await mintSignalingTicket(USER, SECRET, { now }));
    const b = decode(await mintSignalingTicket(USER, SECRET, { now }));
    expect(a).toMatchObject({ sub: USER, purpose: SIGNALING_TICKET_PURPOSE, iat: now, exp: now + TICKET_TTL_SECONDS });
    expect(TICKET_TTL_SECONDS).toBe(120);
    expect(a.jti).not.toBe(b.jti);
  });

  it("rejects a ticket signed with a DIFFERENT secret (Supabase and Render out of sync)", async () => {
    const { verifyClientToken, SignalingAuthError } = await loadVerifier(SECRET);
    const ticket = await mintSignalingTicket(USER, "some-other-secret-value-xxxxxxxxxxxx");
    await expect(verifyClientToken(ticket)).rejects.toBeInstanceOf(SignalingAuthError);
  });

  it("rejects an expired ticket", async () => {
    const { verifyClientToken } = await loadVerifier(SECRET);
    const ticket = await mintSignalingTicket(USER, SECRET, { now: nowSec() - TICKET_TTL_SECONDS - 60 });
    await expect(verifyClientToken(ticket)).rejects.toThrow(/verification failed/);
  });

  it("rejects a real-Supabase-style session token (no purpose claim), even with the right secret", async () => {
    const { verifyClientToken } = await loadVerifier(SECRET);
    const sessionLike = await new SignJWT({ aud: "authenticated", role: "authenticated" })
      .setProtectedHeader({ alg: "HS256" }).setSubject(USER).setIssuedAt().setExpirationTime("1h")
      .sign(new TextEncoder().encode(SECRET));
    await expect(verifyClientToken(sessionLike)).rejects.toThrow(/not a valid signaling ticket/);
  });

  it("rejects a ticket with the wrong purpose or no sub", async () => {
    const { verifyClientToken } = await loadVerifier(SECRET);
    const key = new TextEncoder().encode(SECRET);
    const wrongPurpose = await new SignJWT({ purpose: "something-else" })
      .setProtectedHeader({ alg: "HS256" }).setSubject(USER).setExpirationTime("1m").sign(key);
    const noSub = await new SignJWT({ purpose: SIGNALING_TICKET_PURPOSE })
      .setProtectedHeader({ alg: "HS256" }).setExpirationTime("1m").sign(key);
    await expect(verifyClientToken(wrongPurpose)).rejects.toThrow(/not a valid signaling ticket/);
    await expect(verifyClientToken(noSub)).rejects.toThrow(/missing sub/);
  });

  it("rejects a tampered payload (sub swapped to another user)", async () => {
    const { verifyClientToken } = await loadVerifier(SECRET);
    const [h, , s] = (await mintSignalingTicket(USER, SECRET)).split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "attacker", purpose: SIGNALING_TICKET_PURPOSE, exp: nowSec() + 60 })).toString("base64url");
    await expect(verifyClientToken(`${h}.${forged}.${s}`)).rejects.toThrow();
  });

  it("rejects empty / garbage tokens", async () => {
    const { verifyClientToken } = await loadVerifier(SECRET);
    await expect(verifyClientToken("")).rejects.toThrow(/missing token/);
    await expect(verifyClientToken("not.a.jwt")).rejects.toThrow();
  });

  it("the server refuses everything when SIGNALING_TICKET_SECRET is unset", async () => {
    const { verifyClientToken } = await loadVerifier(undefined);
    const ticket = await mintSignalingTicket(USER, SECRET);
    await expect(verifyClientToken(ticket)).rejects.toThrow(/not configured/);
  });

  it("the minter refuses to mint without a secret or user", async () => {
    await expect(mintSignalingTicket(USER, "")).rejects.toThrow(/not configured/);
    await expect(mintSignalingTicket("", SECRET)).rejects.toThrow(/userId/);
  });

  it("secret resolution: SIGNALING_TICKET_SECRET wins, SUPABASE_JWT_SECRET is fallback, empty → null", () => {
    const env = (o: Record<string, string>) => (k: string) => o[k];
    expect(resolveTicketSecret(env({ SIGNALING_TICKET_SECRET: "a", SUPABASE_JWT_SECRET: "b" }))).toBe("a");
    expect(resolveTicketSecret(env({ SUPABASE_JWT_SECRET: "b" }))).toBe("b");
    expect(resolveTicketSecret(env({ SIGNALING_TICKET_SECRET: "" }))).toBeNull();
  });

  it("only well-formed wss:// URLs are handed to clients", () => {
    expect(resolvePublicSignalingUrl(" wss://duospace-2ua1.onrender.com ")).toBe("wss://duospace-2ua1.onrender.com");
    expect(resolvePublicSignalingUrl("wss://host.example.com:8443/ws")).toBe("wss://host.example.com:8443/ws");
    for (const bad of ["", undefined, null, "ws://insecure.example.com", "https://x.com", "wss://evil.com/ x", "javascript:alert(1)"]) {
      expect(resolvePublicSignalingUrl(bad as string)).toBeNull();
    }
  });
});

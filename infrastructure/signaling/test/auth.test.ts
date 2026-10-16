import { describe, it, expect, beforeEach } from "vitest";
import { SignJWT } from "jose";
import { verifyClientToken, SignalingAuthError, _resetReplayCacheForTests } from "../src/auth.js";

const SECRET = "test-ticket-secret-test-ticket-secret";
process.env.SIGNALING_TICKET_SECRET = SECRET;
const key = new TextEncoder().encode(SECRET);

async function ticket(over: { jti?: string | null; purpose?: string; exp?: number } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({ purpose: over.purpose ?? "duospace-signaling" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("user-1")
    .setIssuedAt(now)
    .setExpirationTime(over.exp ?? now + 120);
  if (over.jti !== null) jwt.setJti(over.jti ?? crypto.randomUUID());
  return jwt.sign(key);
}

describe("signaling ticket replay protection (SIG-001)", () => {
  beforeEach(() => _resetReplayCacheForTests());

  it("accepts a fresh ticket once", async () => {
    expect((await verifyClientToken(await ticket())).userId).toBe("user-1");
  });

  it("rejects the exact same ticket on second use", async () => {
    const t = await ticket();
    await verifyClientToken(t);
    await expect(verifyClientToken(t)).rejects.toThrow(/already used/);
  });

  it("accepts distinct tickets for the same user (reconnect)", async () => {
    await verifyClientToken(await ticket());
    await expect(verifyClientToken(await ticket())).resolves.toEqual({ userId: "user-1" });
  });

  it("rejects a ticket without jti", async () => {
    await expect(verifyClientToken(await ticket({ jti: null }))).rejects.toThrow(SignalingAuthError);
  });

  it("does not consume the jti of a ticket that fails other checks", async () => {
    const bad = await ticket({ jti: "j1", purpose: "wrong" });
    await expect(verifyClientToken(bad)).rejects.toThrow(/valid signaling ticket/);
    await expect(verifyClientToken(await ticket({ jti: "j1" }))).resolves.toBeDefined();
  });
});

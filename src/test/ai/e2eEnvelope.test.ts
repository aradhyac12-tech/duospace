/**
 * Client-side envelope crypto (ECDH P-256 → HKDF-SHA-256 → AES-GCM, AAD-bound).
 * Real WebCrypto. NOTE: this proves the envelope, not E2E inference — E2E
 * additionally requires an attested enclave recipient, which does not exist.
 */
import { describe, it, expect } from "vitest";
import { sealEnvelope, openEnvelope, EnvelopeError, type Envelope } from "@/lib/relationship/e2eCloud/envelope";

const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));
async function recipient() {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  return { priv: kp.privateKey, pubB64: b64(await crypto.subtle.exportKey("raw", kp.publicKey)) };
}
const meta = (id = "req-1", at = 1_000) => ({ purpose: "relationship-reflection", requestId: id, issuedAt: at });
const opts = (seen = new Set<string>(), now = 1_000) => ({ purpose: "relationship-reflection", seen, now, maxAgeMs: 60_000 });
const SECRET = "I felt hurt when the plan changed.";

describe("envelope", () => {
  it("round-trips, and the sealed payload contains no plaintext", async () => {
    const r = await recipient();
    const env = await sealEnvelope(r.pubB64, SECRET, meta());
    expect(JSON.stringify(env)).not.toContain("hurt");
    expect(await openEnvelope(r.priv, env, opts())).toBe(SECRET);
  });

  it("the wrong key cannot decrypt", async () => {
    const [r, other] = [await recipient(), await recipient()];
    const env = await sealEnvelope(r.pubB64, SECRET, meta());
    await expect(openEnvelope(other.priv, env, opts())).rejects.toMatchObject({ reason: "DECRYPT" });
  });

  it("tampered ciphertext, IV, or any AAD field is rejected", async () => {
    const r = await recipient();
    const env = await sealEnvelope(r.pubB64, SECRET, meta());
    const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    const variants: Envelope[] = [
      { ...env, ct: flip(env.ct) }, { ...env, iv: flip(env.iv) },
      { ...env, requestId: "req-2" }, { ...env, issuedAt: env.issuedAt + 1 },
    ];
    for (const v of variants) await expect(openEnvelope(r.priv, v, opts())).rejects.toBeInstanceOf(EnvelopeError);
  });

  it("replay (same requestId twice) and stale requests are rejected", async () => {
    const r = await recipient();
    const seen = new Set<string>();
    const env = await sealEnvelope(r.pubB64, SECRET, meta("once"));
    await openEnvelope(r.priv, env, opts(seen));
    await expect(openEnvelope(r.priv, env, opts(seen))).rejects.toMatchObject({ reason: "REPLAY" });
    const old = await sealEnvelope(r.pubB64, SECRET, meta("old", 0));
    await expect(openEnvelope(r.priv, old, opts(new Set(), 10 * 60_000))).rejects.toMatchObject({ reason: "STALE" });
  });

  it("a request sealed for another purpose is refused", async () => {
    const r = await recipient();
    const env = await sealEnvelope(r.pubB64, SECRET, { ...meta(), purpose: "other" });
    await expect(openEnvelope(r.priv, env, opts())).rejects.toMatchObject({ reason: "PURPOSE" });
  });
});

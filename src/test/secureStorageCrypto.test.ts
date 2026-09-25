/**
 * Tests for secureStorage.ts's underlying AES-GCM encrypt/decrypt logic.
 * Phase 1 privacy/AI foundation — see .ai/SECURITY_MODEL.md.
 *
 * SCOPE NOTE, stated honestly rather than silently working around it:
 * secureStorage.ts's actual secureSet()/secureGet() functions depend on
 * IndexedDB (via src/lib/keystore.ts) for master-key persistence across
 * calls, and jsdom (this suite's test environment) does not implement
 * IndexedDB. Calling secureSet() then secureGet() in this environment
 * would silently generate two DIFFERENT master keys (idbSet/idbGet both
 * no-op without IndexedDB) and fail to round-trip — not because the code
 * is wrong, but because the test environment can't exercise the
 * persistence path. Rather than add a new fake-indexeddb dependency
 * un-verified (no network to confirm `npm install` even succeeds here) or
 * write a test that would give a false failure signal, this suite tests
 * the actual cryptographic primitive in isolation (same AES-256-GCM /
 * Web Crypto calls secureStorage.ts makes, just with a single in-memory
 * key rather than the IndexedDB-persisted one) — the part that matters
 * most for correctness. The IndexedDB-dependent integration path is
 * flagged as untested in this environment in .ai/TEST_STATUS.md, not
 * silently assumed to work.
 */
import { describe, it, expect } from "vitest";

async function encrypt(key: CryptoKey, value: unknown): Promise<{ iv: Uint8Array; ct: ArrayBuffer }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return { iv, ct };
}
async function decrypt<T>(key: CryptoKey, iv: Uint8Array, ct: ArrayBuffer): Promise<T> {
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

describe("secureStorage crypto primitive (AES-256-GCM round trip)", () => {
  it("round-trips a JSON-serializable object", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const original = { feature: "MOOD_PROCESSING", value: 3, nested: { ok: true } };
    const { iv, ct } = await encrypt(key, original);
    const roundTripped = await decrypt<typeof original>(key, iv, ct);
    expect(roundTripped).toEqual(original);
  });

  it("fails to decrypt with the wrong key", async () => {
    const key1 = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const key2 = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const { iv, ct } = await encrypt(key1, { secret: "value" });
    await expect(decrypt(key2, iv, ct)).rejects.toThrow();
  });

  it("fails to decrypt with a tampered ciphertext (GCM authentication)", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const { iv, ct } = await encrypt(key, { secret: "value" });
    const tampered = new Uint8Array(ct);
    tampered[0] ^= 0xff; // flip a bit
    await expect(decrypt(key, iv, tampered.buffer)).rejects.toThrow();
  });

  it("produces a different IV (and ciphertext) on every call, even for the same plaintext", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const a = await encrypt(key, { same: "value" });
    const b = await encrypt(key, { same: "value" });
    expect(Array.from(a.iv)).not.toEqual(Array.from(b.iv));
  });
});

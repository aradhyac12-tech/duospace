/**
 * FIX #7: Real tests replacing the dummy `expect(true).toBe(true)`.
 *
 * Covers:
 *  - crypto.ts  — E2E encrypt/decrypt round-trip, PIN hash/verify
 *  - storage.ts — get/set/remove/getJSON/setJSON helpers
 *  - isEncrypted — prefix detection
 *
 * Run with: npx vitest run
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ─── storage.ts ──────────────────────────────────────────────────────────────
// We mock localStorage so these tests run in Node (vitest jsdom).
const store: Record<string, string> = {};
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v; },
  removeItem: (k: string) => { delete store[k]; },
});

import storage from "@/lib/storage";

describe("storage", () => {
  beforeEach(() => { Object.keys(store).forEach(k => delete store[k]); });

  it("get returns null for missing key", () => {
    expect(storage.get("missing")).toBeNull();
  });

  it("get returns fallback for missing key", () => {
    expect(storage.get("missing", "default")).toBe("default");
  });

  it("set then get round-trips a string", () => {
    storage.set("key", "value");
    expect(storage.get("key")).toBe("value");
  });

  it("remove deletes the key", () => {
    storage.set("key", "value");
    storage.remove("key");
    expect(storage.get("key")).toBeNull();
  });

  it("setJSON then getJSON round-trips an object", () => {
    const obj = { a: 1, b: [2, 3] };
    storage.setJSON("obj", obj);
    expect(storage.getJSON("obj", null)).toEqual(obj);
  });

  it("getJSON returns fallback for missing key", () => {
    expect(storage.getJSON("missing", 42)).toBe(42);
  });

  it("getJSON returns fallback on malformed JSON", () => {
    store["bad"] = "{not json}";
    expect(storage.getJSON("bad", "fallback")).toBe("fallback");
  });
});

// ─── crypto.ts ───────────────────────────────────────────────────────────────
import {
  generateKeyPair,
  encryptMessage,
  decryptMessage,
  isEncrypted,
  hashPin,
  verifyPin,
} from "@/lib/crypto";

describe("isEncrypted", () => {
  it("returns false for plain text", () => {
    expect(isEncrypted("hello")).toBe(false);
  });
  it("returns false for null", () => {
    expect(isEncrypted(null)).toBe(false);
  });
  it("returns true for E2E-prefixed string", () => {
    expect(isEncrypted("E2E::somedata")).toBe(true);
  });
});

describe("crypto — E2E round-trip", () => {
  it("encrypted string starts with E2E:: prefix", async () => {
    const alice = await generateKeyPair();
    const bob   = await generateKeyPair();
    const ct = await encryptMessage("hello", alice.privateKeyJwk, bob.publicKey);
    expect(ct.startsWith("E2E::")).toBe(true);
  });

  it("encrypt then decrypt returns original message", async () => {
    const alice = await generateKeyPair();
    const bob   = await generateKeyPair();
    const original = "Hello, DuoSpace!";
    const ct = await encryptMessage(original, alice.privateKeyJwk, bob.publicKey);
    const pt = await decryptMessage(ct, bob.privateKeyJwk, alice.publicKey);
    expect(pt).toBe(original);
  });

  it("decrypting with wrong key returns error sentinel", async () => {
    const alice   = await generateKeyPair();
    const bob     = await generateKeyPair();
    const charlie = await generateKeyPair();
    const ct = await encryptMessage("secret", alice.privateKeyJwk, bob.publicKey);
    // Charlie's key cannot decrypt a message between Alice and Bob
    const result = await decryptMessage(ct, charlie.privateKeyJwk, alice.publicKey);
    expect(result).toBe("[🔒 Cannot decrypt]");
  });

  it("different messages produce different ciphertexts (unique IV)", async () => {
    const alice = await generateKeyPair();
    const bob   = await generateKeyPair();
    const ct1 = await encryptMessage("msg", alice.privateKeyJwk, bob.publicKey);
    const ct2 = await encryptMessage("msg", alice.privateKeyJwk, bob.publicKey);
    expect(ct1).not.toBe(ct2);
  });
});

describe("crypto — PIN hashing", () => {
  it("verifyPin succeeds with correct PIN", async () => {
    const hash = await hashPin("123456");
    expect(await verifyPin("123456", hash)).toBe(true);
  });

  it("verifyPin fails with wrong PIN", async () => {
    const hash = await hashPin("123456");
    expect(await verifyPin("654321", hash)).toBe(false);
  });

  it("same PIN hashed twice produces different hashes (random salt)", async () => {
    const h1 = await hashPin("000000");
    const h2 = await hashPin("000000");
    expect(h1).not.toBe(h2);
  });

  it("verifyPin handles malformed stored value gracefully", async () => {
    expect(await verifyPin("123456", "notavalidhash")).toBe(false);
  });
});

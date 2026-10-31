/**
 * Tests for resolveAccountIdentityKey() (src/hooks/useE2E.ts) — the fix
 * for "messages unable to decrypt on different platform" (2026-09-20).
 * See supabase/migrations/20260920100000_e2e_account_wide_identity_key.sql
 * for the full root-cause writeup this logic implements the fix for.
 *
 * Supabase is mocked here with a small hand-rolled fake query builder
 * rather than a real client — these tests are about the *sequencing
 * logic* (check existing -> adopt local -> register -> re-fetch winner),
 * not about Supabase/PostgREST itself. Live behavior against a real
 * `user_e2e_identity_keys` table is NOT covered here — no DB access in
 * this environment, same limitation as every other test suite in this
 * project.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = {
  selectMaybeSingleQueue: [] as Array<{ data: unknown; error: unknown }>,
  selectSingleQueue: [] as Array<{ data: unknown; error: unknown }>,
  upsertQueue: [] as Array<{ error: unknown }>,
  upsertCalls: [] as unknown[],
};

function makeFakeSupabase() {
  return {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: string) => ({
          maybeSingle: async () => state.selectMaybeSingleQueue.shift() ?? { data: null, error: null },
          single: async () => state.selectSingleQueue.shift() ?? { data: null, error: null },
        }),
      }),
      upsert: (row: unknown, _opts: unknown) => {
        state.upsertCalls.push(row);
        return Promise.resolve(state.upsertQueue.shift() ?? { error: null });
      },
    }),
  };
}

vi.mock("@/integrations/supabase/appClient", () => ({
  get supabase() {
    return makeFakeSupabase();
  },
}));

vi.mock("@/lib/crypto", async () => {
  const actual = await vi.importActual<typeof import("@/lib/crypto")>("@/lib/crypto");
  return { ...actual, loadKeyPair: vi.fn(), saveKeyPair: vi.fn(), generateKeyPair: vi.fn() };
});

import { resolveAccountIdentityKey, resolveIdentityKeyWithFallback, isSyncTableUnavailable } from "@/hooks/useE2E";
import { loadKeyPair, generateKeyPair } from "@/lib/crypto";

const mockedLoadKeyPair = vi.mocked(loadKeyPair);
const mockedGenerateKeyPair = vi.mocked(generateKeyPair);

beforeEach(() => {
  state.selectMaybeSingleQueue = [];
  state.selectSingleQueue = [];
  state.upsertQueue = [];
  state.upsertCalls = [];
  vi.clearAllMocks();
});

describe("resolveAccountIdentityKey: account already has a canonical key", () => {
  it("adopts the server's existing key without generating or registering a new one", async () => {
    state.selectMaybeSingleQueue.push({
      data: { public_key: "server-pub", private_key_jwk: { kty: "EC", d: "server-priv" } },
      error: null,
    });

    const result = await resolveAccountIdentityKey("user-1");

    expect(result.publicKey).toBe("server-pub");
    expect((result.privateKeyJwk as any).d).toBe("server-priv");
    expect(mockedGenerateKeyPair).not.toHaveBeenCalled();
    expect(state.upsertCalls).toHaveLength(0); // never tried to register anything
  });
});

describe("resolveAccountIdentityKey: no canonical key yet, this device has a local one", () => {
  it("registers the local key as canonical and it wins (no race)", async () => {
    state.selectMaybeSingleQueue.push({ data: null, error: null }); // no existing server key
    mockedLoadKeyPair.mockResolvedValue({ privateKeyJwk: { kty: "EC", d: "local-priv" } as JsonWebKey, publicKey: "local-pub" });
    state.upsertQueue.push({ error: null });
    state.selectSingleQueue.push({
      data: { public_key: "local-pub", private_key_jwk: { kty: "EC", d: "local-priv" } },
      error: null,
    });

    const result = await resolveAccountIdentityKey("user-1");

    expect(result.publicKey).toBe("local-pub");
    expect(mockedGenerateKeyPair).not.toHaveBeenCalled(); // reused the existing local key, didn't mint a new one
    expect(state.upsertCalls).toHaveLength(1);
    expect((state.upsertCalls[0] as any).public_key).toBe("local-pub");
  });

  it("adopts the OTHER device's key if it won the registration race instead", async () => {
    // Simulates: this device's local key lost a simultaneous first-run
    // race against another device's key, which is exactly the migration
    // scenario described in the migration file's own comment.
    state.selectMaybeSingleQueue.push({ data: null, error: null });
    mockedLoadKeyPair.mockResolvedValue({ privateKeyJwk: { kty: "EC", d: "this-devices-priv" } as JsonWebKey, publicKey: "this-devices-pub" });
    state.upsertQueue.push({ error: null }); // ignoreDuplicates swallows the conflict silently
    state.selectSingleQueue.push({
      data: { public_key: "other-devices-pub", private_key_jwk: { kty: "EC", d: "other-devices-priv" } },
      error: null,
    });

    const result = await resolveAccountIdentityKey("user-1");

    // The re-fetched winner is authoritative, even though it's not what
    // this device tried to register.
    expect(result.publicKey).toBe("other-devices-pub");
    expect((result.privateKeyJwk as any).d).toBe("other-devices-priv");
  });
});

describe("resolveAccountIdentityKey: truly first-ever setup (no server key, no local key)", () => {
  it("generates a new keypair and registers it", async () => {
    state.selectMaybeSingleQueue.push({ data: null, error: null });
    mockedLoadKeyPair.mockResolvedValue(null);
    mockedGenerateKeyPair.mockResolvedValue({ publicKey: "fresh-pub", privateKeyJwk: { kty: "EC", d: "fresh-priv" } as JsonWebKey });
    state.upsertQueue.push({ error: null });
    state.selectSingleQueue.push({
      data: { public_key: "fresh-pub", private_key_jwk: { kty: "EC", d: "fresh-priv" } },
      error: null,
    });

    const result = await resolveAccountIdentityKey("user-1");

    expect(mockedGenerateKeyPair).toHaveBeenCalledTimes(1);
    expect(result.publicKey).toBe("fresh-pub");
  });
});

describe("resolveAccountIdentityKey: error propagation", () => {
  it("throws if the initial existence check fails (caller's existing retry/backoff handles it)", async () => {
    state.selectMaybeSingleQueue.push({ data: null, error: new Error("network blip") });
    await expect(resolveAccountIdentityKey("user-1")).rejects.toThrow();
  });

  it("throws if the post-upsert re-fetch fails", async () => {
    state.selectMaybeSingleQueue.push({ data: null, error: null });
    mockedLoadKeyPair.mockResolvedValue(null);
    mockedGenerateKeyPair.mockResolvedValue({ publicKey: "fresh-pub", privateKeyJwk: { kty: "EC" } as JsonWebKey });
    state.upsertQueue.push({ error: null });
    state.selectSingleQueue.push({ data: null, error: new Error("network blip") });
    await expect(resolveAccountIdentityKey("user-1")).rejects.toThrow();
  });
});

// ─── "Securing connection…" fix (2026-09-19) ────────────────────────────────
// If migration 20260920100000 was never applied, the key-sync table doesn't
// exist. init() used to retry forever on that error, so E2E never became
// ready and every text send only produced the "Securing connection…" toast.

describe("isSyncTableUnavailable", () => {
  it("recognises a missing/unreadable sync table", () => {
    expect(isSyncTableUnavailable({ code: "PGRST205", message: "x" })).toBe(true);
    expect(isSyncTableUnavailable({ code: "42P01", message: "x" })).toBe(true);
    expect(isSyncTableUnavailable({ code: "42501", message: "x" })).toBe(true);
    expect(isSyncTableUnavailable({ message: "Could not find the table 'public.user_e2e_identity_keys' in the schema cache" })).toBe(true);
    expect(isSyncTableUnavailable({ message: 'relation "public.user_e2e_identity_keys" does not exist' })).toBe(true);
  });

  it("does NOT treat transient failures as a missing table", () => {
    expect(isSyncTableUnavailable(new Error("network blip"))).toBe(false);
    expect(isSyncTableUnavailable({ message: "Failed to fetch" })).toBe(false);
    expect(isSyncTableUnavailable(null)).toBe(false);
    expect(isSyncTableUnavailable(undefined)).toBe(false);
  });
});

describe("resolveIdentityKeyWithFallback", () => {
  const missingTable = { code: "PGRST205", message: "Could not find the table 'public.user_e2e_identity_keys' in the schema cache" };

  it("returns the synced key when the table works", async () => {
    state.selectMaybeSingleQueue.push({
      data: { public_key: "server-pub", private_key_jwk: { kty: "EC", d: "server-priv" } },
      error: null,
    });
    const result = await resolveIdentityKeyWithFallback("user-1");
    expect(result.synced).toBe(true);
    expect(result.publicKey).toBe("server-pub");
  });

  it("falls back to this device's local key when the table is missing", async () => {
    state.selectMaybeSingleQueue.push({ data: null, error: missingTable });
    mockedLoadKeyPair.mockResolvedValue({ privateKeyJwk: { kty: "EC", d: "local-priv" } as JsonWebKey, publicKey: "local-pub" });

    const result = await resolveIdentityKeyWithFallback("user-1");

    expect(result.synced).toBe(false);
    expect(result.publicKey).toBe("local-pub");
    expect(mockedGenerateKeyPair).not.toHaveBeenCalled();
  });

  it("mints a fresh key when the table is missing and there is no local key", async () => {
    state.selectMaybeSingleQueue.push({ data: null, error: missingTable });
    mockedLoadKeyPair.mockResolvedValue(null);
    mockedGenerateKeyPair.mockResolvedValue({ publicKey: "fresh-pub", privateKeyJwk: { kty: "EC", d: "fresh-priv" } as JsonWebKey });

    const result = await resolveIdentityKeyWithFallback("user-1");

    expect(result.synced).toBe(false);
    expect(result.publicKey).toBe("fresh-pub");
    expect(mockedGenerateKeyPair).toHaveBeenCalledTimes(1);
  });

  it("still throws on a transient error so the caller keeps retrying", async () => {
    state.selectMaybeSingleQueue.push({ data: null, error: new Error("network blip") });
    await expect(resolveIdentityKeyWithFallback("user-1")).rejects.toThrow();
    expect(mockedGenerateKeyPair).not.toHaveBeenCalled();
  });
});

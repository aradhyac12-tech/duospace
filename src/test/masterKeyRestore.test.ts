/**
 * secureStorage.getOrCreateMasterKey + the OS-keystore backup (privacy/masterKeyBackup.ts).
 * The three paths that matter: key present, key confirmed absent (restore before minting),
 * and read FAILURE (must never restore or mint — that is the original "orphaned history" bug).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const idbGetStrict = vi.fn(async (_k: string): Promise<unknown> => null);
const idbSet = vi.fn(async (_k: string, _v: unknown) => {});
const idbDelete = vi.fn(async (_k: string) => {});
const backup = vi.fn(async (_u: string, _j: unknown) => {});
const restore = vi.fn(async (_u: string): Promise<unknown> => null);
const remove = vi.fn(async (_u: string) => {});

vi.mock("@/lib/keystore", () => ({
  idbGetStrict: (k: string) => idbGetStrict(k),
  idbSet: (k: string, v: unknown) => idbSet(k, v),
  idbDelete: (k: string) => idbDelete(k),
}));
vi.mock("@/lib/prefs", () => ({ default: { get: vi.fn(async () => null), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) } }));
vi.mock("@/lib/privacy/masterKeyBackup", () => ({
  masterKeyBackup: { backup: (u: string, j: unknown) => backup(u, j), restore: (u: string) => restore(u), remove: (u: string) => remove(u) },
}));

async function freshJwk(): Promise<JsonWebKey> {
  const k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  return crypto.subtle.exportKey("jwk", k);
}

describe("master key: restore before mint", () => {
  beforeEach(() => { vi.resetModules(); idbGetStrict.mockReset(); idbSet.mockClear(); backup.mockClear(); restore.mockReset(); remove.mockClear(); });

  it("existing IndexedDB key: used as is, backed up, no restore", async () => {
    const jwk = await freshJwk();
    idbGetStrict.mockResolvedValue(jwk);
    const { getOrCreateMasterKey } = await import("@/lib/privacy/secureStorage");
    await getOrCreateMasterKey("u1");
    expect(restore).not.toHaveBeenCalled();
    expect(idbSet).not.toHaveBeenCalled();
    expect(backup).toHaveBeenCalledWith("u1", jwk);
  });

  it("IndexedDB empty + keystore has the key: restored (not regenerated) and written back to IndexedDB", async () => {
    const saved = await freshJwk();
    idbGetStrict.mockResolvedValue(null);
    restore.mockResolvedValue(saved);
    const { getOrCreateMasterKey } = await import("@/lib/privacy/secureStorage");
    const key = await getOrCreateMasterKey("u1");
    expect(idbSet).toHaveBeenCalledWith("duo_secure_storage_master_key_u1", saved);
    // It is the SAME key: data sealed with the saved JWK opens with the returned key.
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const imported = await crypto.subtle.importKey("jwk", saved, { name: "AES-GCM" }, false, ["encrypt"]);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, imported, new TextEncoder().encode("x"));
    expect(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct))).toBe("x");
    expect(backup).not.toHaveBeenCalled();
  });

  it("IndexedDB empty + no backup: mints a new key and backs it up", async () => {
    idbGetStrict.mockResolvedValue(null);
    restore.mockResolvedValue(null);
    const { getOrCreateMasterKey } = await import("@/lib/privacy/secureStorage");
    await getOrCreateMasterKey("u1");
    expect(idbSet).toHaveBeenCalledTimes(1);
    expect(backup).toHaveBeenCalledTimes(1);
  });

  it("IndexedDB READ FAILURE: throws; never restores and never mints", async () => {
    idbGetStrict.mockRejectedValue(new Error("idb timeout"));
    const { getOrCreateMasterKey } = await import("@/lib/privacy/secureStorage");
    await expect(getOrCreateMasterKey("u1")).rejects.toThrow();
    expect(restore).not.toHaveBeenCalled();
    expect(idbSet).not.toHaveBeenCalled();
  }, 15_000);

  it("secureWipeAll also removes the keystore copy", async () => {
    const { secureWipeAll } = await import("@/lib/privacy/secureStorage");
    await secureWipeAll("u1");
    expect(remove).toHaveBeenCalledWith("u1");
    expect(idbDelete).toHaveBeenCalledWith("duo_secure_storage_master_key_u1");
  });
});

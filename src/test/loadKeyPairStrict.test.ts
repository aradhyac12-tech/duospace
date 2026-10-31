import { describe, it, expect, vi, beforeEach } from "vitest";

const idbGetStrict = vi.fn(async (_k: string): Promise<unknown> => null);
const idbSet = vi.fn(async (_k: string, _v: unknown) => {});
vi.mock("@/lib/keystore", () => ({
  idbGetStrict: (k: string) => idbGetStrict(k),
  idbSet: (k: string, v: unknown) => idbSet(k, v),
  idbDelete: vi.fn(async () => {}),
}));

import { loadKeyPair } from "@/lib/crypto";

const kp = { privateKeyJwk: { kty: "EC" } as JsonWebKey, publicKey: "pub" };

describe("loadKeyPair (strict)", () => {
  beforeEach(() => { idbGetStrict.mockReset(); idbSet.mockClear(); localStorage.clear(); });

  it("returns the stored pair", async () => {
    idbGetStrict.mockResolvedValue(kp);
    expect(await loadKeyPair("u1")).toEqual(kp);
  });

  it("returns null only when the read completed and found nothing", async () => {
    idbGetStrict.mockResolvedValue(null);
    expect(await loadKeyPair("u1")).toBeNull();
  });

  it("retries a transient failure and then succeeds", async () => {
    idbGetStrict.mockRejectedValueOnce(new Error("blip")).mockResolvedValue(kp);
    expect(await loadKeyPair("u1")).toEqual(kp);
    expect(idbGetStrict).toHaveBeenCalledTimes(2);
  });

  it("THROWS (never null) when the read keeps failing — so no caller mints a new key", async () => {
    idbGetStrict.mockRejectedValue(new Error("idb timeout"));
    await expect(loadKeyPair("u1")).rejects.toThrow("idb timeout");
    expect(idbGetStrict).toHaveBeenCalledTimes(3);
  }, 15_000);

  it("still migrates a legacy localStorage copy when IndexedDB is confirmed empty", async () => {
    idbGetStrict.mockResolvedValue(null);
    localStorage.setItem("duo_e2e_keypair_u1", JSON.stringify(kp));
    expect(await loadKeyPair("u1")).toEqual(kp);
    expect(idbSet).toHaveBeenCalledWith("duo_e2e_keypair_u1", kp);
  });
});

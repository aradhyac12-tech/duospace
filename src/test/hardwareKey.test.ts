import { describe, it, expect, vi } from "vitest";
import { resolveHardwareKeyBytes, type HwCredentialStore, type HwMarker } from "@/lib/privacy/secureKey";

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const bytes = (fill: number, n = 32) => new Uint8Array(n).fill(fill);

function fakes(opts: { stored?: string | null; marker?: boolean; failReads?: boolean; dropWrites?: boolean } = {}) {
  let stored: string | null = opts.stored ?? null;
  let marker = !!opts.marker;
  const store: HwCredentialStore & { sets: number } = {
    sets: 0,
    async get() { if (opts.failReads) throw new Error("keystore locked"); return stored; },
    async set(v) { store.sets++; if (!opts.dropWrites) stored = v; },
  };
  const m: HwMarker = { async isSet() { return marker; }, async set() { marker = true; } };
  return { store, m, state: () => ({ stored, marker }) };
}

describe("resolveHardwareKeyBytes", () => {
  it("first use: creates, verifies by reading back, then sets the marker", async () => {
    const f = fakes();
    const k = await resolveHardwareKeyBytes(f.store, f.m, () => bytes(7));
    expect([...k!]).toEqual([...bytes(7)]);
    expect(f.state()).toEqual({ stored: b64(bytes(7)), marker: true });
  });

  it("an existing readable key is used as is (no write) and heals a missing marker", async () => {
    const f = fakes({ stored: b64(bytes(5)) });
    const k = await resolveHardwareKeyBytes(f.store, f.m, () => bytes(9));
    expect([...k!]).toEqual([...bytes(5)]);
    expect(f.store.sets).toBe(0);
    expect(f.state().marker).toBe(true);
  });

  it("NEVER regenerates: unreadable key + marker set → null, nothing written", async () => {
    const f = fakes({ marker: true, failReads: true });
    expect(await resolveHardwareKeyBytes(f.store, f.m, () => bytes(9))).toBeNull();
    expect(f.store.sets).toBe(0);
  });

  it("keystore that does not keep the write → null and no marker (vault fallback)", async () => {
    const f = fakes({ dropWrites: true });
    expect(await resolveHardwareKeyBytes(f.store, f.m, () => bytes(1))).toBeNull();
    expect(f.state().marker).toBe(false);
  });

  it("something stored that is not a 32-byte key is never overwritten", async () => {
    const f = fakes({ stored: b64(bytes(3, 10)) });
    expect(await resolveHardwareKeyBytes(f.store, f.m, () => bytes(9))).toBeNull();
    expect(f.store.sets).toBe(0);
  });

  it("garbage (not base64) is never overwritten", async () => {
    const f = fakes({ stored: "%%%not-base64%%%" });
    expect(await resolveHardwareKeyBytes(f.store, f.m, () => bytes(9))).toBeNull();
    expect(f.store.sets).toBe(0);
  });

  it("an unreadable marker is treated as 'was created' (safe side)", async () => {
    const f = fakes();
    f.m.isSet = vi.fn(async () => { throw new Error("prefs down"); });
    expect(await resolveHardwareKeyBytes(f.store, f.m, () => bytes(9))).toBeNull();
    expect(f.store.sets).toBe(0);
  });

  it("is stable across launches: second call returns the same key", async () => {
    const f = fakes();
    const a = await resolveHardwareKeyBytes(f.store, f.m, () => bytes(7));
    const b = await resolveHardwareKeyBytes(f.store, f.m, () => bytes(8));
    expect([...b!]).toEqual([...a!]);
  });
});

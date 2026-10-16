import { describe, it, expect } from "vitest";
import { createMasterKeyBackup, type KeyBackupStore } from "@/lib/privacy/masterKeyBackup";

const jwk = { kty: "oct", k: "abc123", alg: "A256GCM", ext: true, key_ops: ["encrypt", "decrypt"] } as JsonWebKey;

function memStore(): KeyBackupStore & { data: Map<string, string>; sets: number } {
  const data = new Map<string, string>();
  const o = {
    data, sets: 0,
    async get(u: string) { return data.get(u) ?? null; },
    async set(u: string, j: string) { o.sets++; data.set(u, j); },
    async remove(u: string) { data.delete(u); },
  };
  return o;
}

describe("masterKeyBackup", () => {
  it("backs up once per session and restores the same key", async () => {
    const st = memStore();
    const b = createMasterKeyBackup(st);
    await b.backup("u1", jwk);
    await b.backup("u1", jwk);
    expect(st.sets).toBe(1);
    expect(await createMasterKeyBackup(st).restore("u1")).toEqual(jwk);
  });

  it("does not rewrite an identical stored key in a new session", async () => {
    const st = memStore();
    await createMasterKeyBackup(st).backup("u1", jwk);
    await createMasterKeyBackup(st).backup("u1", jwk);
    expect(st.sets).toBe(1);
  });

  it("remove deletes the backup (a wiped user cannot be reopened)", async () => {
    const st = memStore();
    const b = createMasterKeyBackup(st);
    await b.backup("u1", jwk);
    await b.remove("u1");
    expect(await b.restore("u1")).toBeNull();
  });

  it("is per user", async () => {
    const st = memStore();
    const b = createMasterKeyBackup(st);
    await b.backup("u1", jwk);
    expect(await b.restore("u2")).toBeNull();
  });

  it("rejects garbage / non-AES material", async () => {
    const st = memStore();
    st.data.set("u1", "not json");
    expect(await createMasterKeyBackup(st).restore("u1")).toBeNull();
    st.data.set("u1", JSON.stringify({ kty: "RSA" }));
    expect(await createMasterKeyBackup(st).restore("u1")).toBeNull();
  });

  it("never throws when the store does, and retries the backup next time", async () => {
    let fail = true;
    const data = new Map<string, string>();
    const st: KeyBackupStore = {
      async get(u) { if (fail) throw new Error("keystore locked"); return data.get(u) ?? null; },
      async set(u, j) { data.set(u, j); },
      async remove() { /* */ },
    };
    const b = createMasterKeyBackup(st);
    await b.backup("u1", jwk);                 // fails silently
    expect(await b.restore("u1")).toBeNull();  // fails silently
    fail = false;
    await b.backup("u1", jwk);                 // retried (not marked done)
    expect(await b.restore("u1")).toEqual(jwk);
  });

  it("web (no store) is a set of no-ops", async () => {
    const b = createMasterKeyBackup(null);
    await b.backup("u1", jwk);
    expect(await b.restore("u1")).toBeNull();
    await b.remove("u1");
  });
});

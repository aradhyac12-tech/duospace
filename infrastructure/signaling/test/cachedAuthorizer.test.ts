import { describe, it, expect } from "vitest";
import { CachedCallAuthorizer, parseCachedFacts } from "../src/cachedAuthorizer.js";
import { AuthorizerUnavailableError } from "../src/authorizer.js";
import { encodeCommand, parseReply, type CacheStore } from "../src/redisCache.js";
import { FakeAuthorizer, facts, CALL_ID, CALL_ID_2 } from "./helpers.js";

class MemStore implements CacheStore {
  data = new Map<string, string>();
  down = false;
  ttl = new Map<string, number>();
  async get(k: string) { if (this.down) throw new Error("down"); return this.data.get(k) ?? null; }
  async set(k: string, v: string, t: number) { if (this.down) throw new Error("down"); this.data.set(k, v); this.ttl.set(k, t); }
  async del(k: string) { this.data.delete(k); }
  close() {}
  status() { return this.down ? "down" : "ok"; }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("CachedCallAuthorizer", () => {
  it("caches a FINAL call's facts and serves the second lookup from the cache", async () => {
    const inner = new FakeAuthorizer(); inner.set(facts({ status: "completed" }));
    const store = new MemStore();
    const a = new CachedCallAuthorizer(inner, store);
    expect((await a.getCallFacts(CALL_ID))?.status).toBe("completed");
    await flush();
    expect((await a.getCallFacts(CALL_ID))?.status).toBe("completed");
    expect(inner.lookups).toBe(1);
    expect(a.stats.hits).toBe(1);
  });

  it("NEVER caches a live (in_progress) call — CALL_ACCEPTED must see the current claim", async () => {
    const inner = new FakeAuthorizer(); inner.set(facts({ status: "in_progress" }));
    const store = new MemStore();
    const a = new CachedCallAuthorizer(inner, store);
    await a.getCallFacts(CALL_ID);
    inner.set(facts({ status: "in_progress", claimedBy: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }));
    const second = await a.getCallFacts(CALL_ID);
    await flush();
    expect(second?.claimedBy).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(inner.lookups).toBe(2);
    expect(store.data.size).toBe(0);
  });

  it("does not cache missed/seen (follow-on transitions) or unknown calls", async () => {
    const inner = new FakeAuthorizer(); inner.set(facts({ status: "missed" }));
    const store = new MemStore();
    const a = new CachedCallAuthorizer(inner, store);
    await a.getCallFacts(CALL_ID);
    expect(await a.getCallFacts(CALL_ID_2)).toBeNull();
    await flush();
    expect(store.data.size).toBe(0);
  });

  it("fails open when the cache is down — falls through to the database", async () => {
    const inner = new FakeAuthorizer(); inner.set(facts({ status: "cancelled" }));
    const store = new MemStore(); store.down = true;
    const a = new CachedCallAuthorizer(inner, store);
    expect((await a.getCallFacts(CALL_ID))?.status).toBe("cancelled");
    expect(inner.lookups).toBe(1);
  });

  it("still propagates AuthorizerUnavailableError (gateway fails closed)", async () => {
    const inner = new FakeAuthorizer(); inner.down = true;
    const a = new CachedCallAuthorizer(inner, new MemStore());
    await expect(a.getCallFacts(CALL_ID)).rejects.toBeInstanceOf(AuthorizerUnavailableError);
  });

  it("ignores a corrupt or mismatched cache entry and refetches", async () => {
    const inner = new FakeAuthorizer(); inner.set(facts({ status: "completed" }));
    const store = new MemStore();
    store.data.set(`duo:sig:facts:v1:${CALL_ID}`, "{not json");
    const a = new CachedCallAuthorizer(inner, store);
    expect((await a.getCallFacts(CALL_ID))?.status).toBe("completed");
    expect(inner.lookups).toBe(1);
  });

  it("never builds a key from a non-uuid call id", async () => {
    const inner = new FakeAuthorizer();
    const store = new MemStore();
    const a = new CachedCallAuthorizer(inner, store);
    await a.getCallFacts("../../etc/passwd\r\nFLUSHALL");
    expect(store.data.size).toBe(0);
  });

  it("parseCachedFacts rejects live-status or wrong-call entries", () => {
    const f = facts({ status: "in_progress" });
    expect(parseCachedFacts(JSON.stringify(f), CALL_ID)).toBeNull();
    const done = facts({ status: "completed" });
    expect(parseCachedFacts(JSON.stringify(done), CALL_ID_2)).toBeNull();
    expect(parseCachedFacts(JSON.stringify(done), CALL_ID)?.status).toBe("completed");
  });
});

describe("RESP codec", () => {
  it("encodes commands as bulk-string arrays (binary-safe lengths)", () => {
    expect(encodeCommand(["SET", "k", "é", "EX", 5]).toString("utf8")).toBe("*5\r\n$3\r\nSET\r\n$1\r\nk\r\n$2\r\né\r\n$2\r\nEX\r\n$1\r\n5\r\n");
  });
  it("parses simple, error, integer, bulk, null and array replies", () => {
    expect(parseReply(Buffer.from("+OK\r\n"))?.value).toBe("OK");
    expect(parseReply(Buffer.from(":42\r\n"))?.value).toBe(42);
    expect(parseReply(Buffer.from("$-1\r\n"))?.value).toBeNull();
    expect(parseReply(Buffer.from("$5\r\nhello\r\n"))?.value).toBe("hello");
    expect(parseReply(Buffer.from("-ERR nope\r\n"))?.value).toEqual({ error: "ERR nope" });
    expect(parseReply(Buffer.from("*2\r\n$1\r\na\r\n:1\r\n"))?.value).toEqual(["a", 1]);
  });
  it("returns null for an incomplete frame and throws on garbage", () => {
    expect(parseReply(Buffer.from("$5\r\nhel"))).toBeNull();
    expect(parseReply(Buffer.from("+OK"))).toBeNull();
    expect(() => parseReply(Buffer.from("?what\r\n"))).toThrow();
  });
});

/**
 * redisCache — a tiny, optional, FAIL-OPEN Redis cache for the signaling gateway.
 *
 * Why hand-rolled: this package's lockfile is part of the deploy contract
 * (DEPLOYMENT_INVARIANTS.md) and an extra npm dependency would have to be
 * installed + locked on a networked machine. A cache only needs GET / SET EX /
 * DEL, which is a few dozen lines of RESP over node:net / node:tls, so there is
 * no new dependency to ship. (Swap in ioredis later if you ever need more.)
 *
 * Contract — the cache is an OPTIMISATION, never a source of truth:
 *   • Redis down / slow / returning garbage  → every call behaves as a cache MISS
 *     (get → null, set/del → no-op). Nothing here can make a call fail.
 *   • Each command has a hard timeout (default 250 ms).
 *   • After a failure the store stays "open-circuit" for 10 s (no reconnect
 *     storm, no per-message latency tax), then tries again.
 *   • Keys/values are plain strings; callers decide what is safe to cache.
 *
 * NOT RUNTIME-VERIFIED against a real Redis server (none reachable from the
 * environment this was written in). The RESP reader/encoder is unit-tested.
 */
import net from "node:net";
import tls from "node:tls";

export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  close(): void;
  /** For /healthz: "ok" | "down" (circuit open) | "connecting". */
  status(): string;
}

// ─── RESP encode / decode (exported for tests) ───────────────────────────────

export function encodeCommand(args: Array<string | number>): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const a of args) {
    const b = Buffer.from(String(a), "utf8");
    parts.push(Buffer.from(`$${b.length}\r\n`), b, Buffer.from("\r\n"));
  }
  return Buffer.concat(parts);
}

export type RespValue = string | number | null | RespValue[] | { error: string };

/** Parse ONE reply from `buf` at `offset`. Returns null when the reply is incomplete. */
export function parseReply(buf: Buffer, offset = 0): { value: RespValue; next: number } | null {
  if (offset >= buf.length) return null;
  const type = String.fromCharCode(buf[offset]);
  const eol = buf.indexOf("\r\n", offset, "utf8");
  if (eol === -1) return null;
  const line = buf.toString("utf8", offset + 1, eol);
  const after = eol + 2;

  switch (type) {
    case "+": return { value: line, next: after };
    case "-": return { value: { error: line }, next: after };
    case ":": return { value: Number(line), next: after };
    case "$": {
      const len = Number(line);
      if (len === -1) return { value: null, next: after };
      if (!Number.isInteger(len) || len < 0 || len > 8 * 1024 * 1024) throw new Error("bad bulk length");
      if (buf.length < after + len + 2) return null;
      return { value: buf.toString("utf8", after, after + len), next: after + len + 2 };
    }
    case "*": {
      const n = Number(line);
      if (n === -1) return { value: null, next: after };
      if (!Number.isInteger(n) || n < 0 || n > 1024) throw new Error("bad array length");
      const out: RespValue[] = [];
      let cur = after;
      for (let i = 0; i < n; i++) {
        const r = parseReply(buf, cur);
        if (!r) return null;
        out.push(r.value);
        cur = r.next;
      }
      return { value: out, next: cur };
    }
    default:
      throw new Error(`unexpected RESP type byte ${JSON.stringify(type)}`);
  }
}

// ─── Client ──────────────────────────────────────────────────────────────────

interface Pending { resolve: (v: RespValue) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

export interface RedisCacheOptions {
  commandTimeoutMs?: number;
  connectTimeoutMs?: number;
  /** How long to stay in "down" after a failure before trying again. */
  circuitOpenMs?: number;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export class RedisCacheStore implements CacheStore {
  private readonly host: string;
  private readonly port: number;
  private readonly useTls: boolean;
  private readonly username: string | null;
  private readonly password: string | null;
  private readonly db: number;
  private readonly cmdTimeout: number;
  private readonly connectTimeout: number;
  private readonly circuitOpenMs: number;
  private readonly log: (event: string, data: Record<string, unknown>) => void;

  private socket: net.Socket | null = null;
  private ready: Promise<void> | null = null;
  private rx: Buffer = Buffer.alloc(0);
  private queue: Pending[] = [];
  private downUntil = 0;

  /** `url`: redis://[user:pass@]host[:port][/db]  or  rediss://… for TLS. */
  constructor(url: string, opts: RedisCacheOptions = {}) {
    const u = new URL(url);
    if (u.protocol !== "redis:" && u.protocol !== "rediss:") throw new Error("REDIS_URL must start with redis:// or rediss://");
    this.useTls = u.protocol === "rediss:";
    this.host = u.hostname;
    this.port = u.port ? Number(u.port) : 6379;
    this.username = u.username ? decodeURIComponent(u.username) : null;
    this.password = u.password ? decodeURIComponent(u.password) : null;
    const dbNum = u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0;
    this.db = Number.isInteger(dbNum) && dbNum >= 0 ? dbNum : 0;
    this.cmdTimeout = opts.commandTimeoutMs ?? 250;
    this.connectTimeout = opts.connectTimeoutMs ?? 1000;
    this.circuitOpenMs = opts.circuitOpenMs ?? 10_000;
    this.log = opts.log ?? (() => {});
  }

  status(): string {
    if (Date.now() < this.downUntil) return "down";
    return this.socket && this.ready ? "ok" : "connecting";
  }

  async get(key: string): Promise<string | null> {
    const r = await this.run(["GET", key]);
    return typeof r === "string" ? r : null;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.run(["SET", key, value, "EX", Math.max(1, Math.floor(ttlSeconds))]);
  }

  async del(key: string): Promise<void> {
    await this.run(["DEL", key]);
  }

  close(): void {
    this.teardown(new Error("closed"));
  }

  // Never throws: any failure opens the circuit and reads as a miss.
  private async run(args: Array<string | number>): Promise<RespValue> {
    if (Date.now() < this.downUntil) return null;
    try {
      await this.connect();
      return await this.send(args);
    } catch (err) {
      this.trip(err as Error);
      return null;
    }
  }

  private trip(err: Error): void {
    this.downUntil = Date.now() + this.circuitOpenMs;
    this.log("redis_cache_unavailable", { reason: err.message.slice(0, 120), retryInMs: this.circuitOpenMs });
    this.teardown(err);
  }

  private teardown(err: Error): void {
    const s = this.socket;
    this.socket = null;
    this.ready = null;
    this.rx = Buffer.alloc(0);
    for (const p of this.queue.splice(0)) { clearTimeout(p.timer); p.reject(err); }
    if (s) { s.removeAllListeners(); s.on("error", () => {}); s.destroy(); }
  }

  private connect(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const onConnect = () => {
        clearTimeout(timer);
        this.handshake().then(resolve, reject);
      };
      const sock: net.Socket = this.useTls
        ? tls.connect({ host: this.host, port: this.port, servername: this.host }, onConnect)
        : net.connect({ host: this.host, port: this.port }, onConnect);
      const timer = setTimeout(() => reject(new Error("connect timeout")), this.connectTimeout);
      sock.setNoDelay(true);
      sock.on("data", (d) => this.onData(d));
      sock.on("error", (e) => { clearTimeout(timer); reject(e); this.trip(e); });
      sock.on("close", () => { if (this.socket === sock) this.trip(new Error("socket closed")); });
      this.socket = sock;
    });
    this.ready.catch(() => { /* surfaced through run() */ });
    return this.ready;
  }

  private async handshake(): Promise<void> {
    if (this.password) {
      const r = await this.send(this.username ? ["AUTH", this.username, this.password] : ["AUTH", this.password]);
      if (typeof r === "object" && r !== null && !Array.isArray(r) && "error" in r) throw new Error("AUTH rejected");
    }
    if (this.db) await this.send(["SELECT", this.db]);
  }

  private send(args: Array<string | number>): Promise<RespValue> {
    return new Promise<RespValue>((resolve, reject) => {
      const sock = this.socket;
      if (!sock) { reject(new Error("not connected")); return; }
      const timer = setTimeout(() => reject(new Error("command timeout")), this.cmdTimeout);
      // FIFO: Redis answers commands in the order they were written.
      this.queue.push({ resolve, reject, timer });
      sock.write(encodeCommand(args));
    }).then((v) => {
      if (typeof v === "object" && v !== null && !Array.isArray(v) && "error" in v) throw new Error(`redis: ${v.error}`);
      return v;
    });
  }

  private onData(chunk: Buffer): void {
    this.rx = this.rx.length ? Buffer.concat([this.rx, chunk]) : chunk;
    try {
      for (;;) {
        const r = parseReply(this.rx, 0);
        if (!r) break;
        this.rx = this.rx.subarray(r.next);
        const p = this.queue.shift();
        if (p) { clearTimeout(p.timer); p.resolve(r.value); }
      }
    } catch (err) {
      this.trip(err as Error); // desynchronised stream — start over
    }
  }
}

/**
 * Keyed in-flight de-duplication for cloud AI requests.
 *
 *  - Identical requests (same key) share ONE promise → one gateway call → one server charge.
 *  - Different keys (other message / other user / other intent) NEVER share a result.
 *  - Bounded: at most MAX_INFLIGHT concurrent distinct requests; extra ones are refused
 *    (caller shows an honest "try again") instead of growing without limit.
 *  - Entries are removed on success AND failure (finally), so nothing is cached after settling.
 *  - Keys are hashed; raw message text is never stored as a key or logged.
 */
export const MAX_INFLIGHT = 4;

/** Small non-cryptographic hash (FNV-1a, 32-bit ×2 seeds). Only for map keys, not security. */
export function hashKey(parts: readonly unknown[]): string {
  const s = JSON.stringify(parts);
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(36)}.${h2.toString(36)}.${s.length}`;
}

export interface Dedupe<T> {
  /** Returns the shared promise for `key`, or `refused` if the concurrency bound is hit. */
  run(key: string, start: () => Promise<T>, refused: T): Promise<T>;
  size(): number;
  clear(): void;
}

export function createDedupe<T>(max: number = MAX_INFLIGHT): Dedupe<T> {
  const m = new Map<string, Promise<T>>();
  return {
    run(key, start, refused) {
      const existing = m.get(key);
      if (existing) return existing;
      if (m.size >= max) return Promise.resolve(refused);
      const p = Promise.resolve().then(start).finally(() => { m.delete(key); });
      m.set(key, p);
      return p;
    },
    size: () => m.size,
    clear: () => m.clear(),
  };
}

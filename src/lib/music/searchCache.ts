/**
 * Search-result cache + in-flight de-duplication, per provider and query.
 *
 * WHY: each keystroke batch fired up to 5 provider searches (each an edge function with a 60/min
 * rate-limit bucket). Backspacing, retyping, or leaving and re-entering search re-hit all of them,
 * which is slow AND can exhaust the bucket (a 429 then reads as "no results"). Identical queries
 * within the TTL now answer instantly from memory, and two concurrent identical searches share
 * one request.
 *
 * Only NON-EMPTY successes are cached: an empty list may be a transient provider hiccup, and a
 * failure must stay retryable (the retry button re-runs the effect and must really re-request).
 */
export function createSearchCache<T>(opts: { ttlMs?: number; max?: number; now?: () => number } = {}) {
  const ttl = opts.ttlMs ?? 5 * 60_000;
  const max = opts.max ?? 80;
  const now = opts.now ?? (() => Date.now());
  const store = new Map<string, { value: T[]; at: number }>();
  const inflight = new Map<string, Promise<T[]>>();
  const keyOf = (provider: string, q: string) => `${provider}:${q.trim().toLowerCase().replace(/\s+/g, " ")}`;

  function run(provider: string, q: string, fn: () => Promise<T[]>): Promise<T[]> {
    const k = keyOf(provider, q);
    const hit = store.get(k);
    if (hit && now() - hit.at < ttl) { store.delete(k); store.set(k, hit); return Promise.resolve(hit.value); } // LRU touch
    const running = inflight.get(k);
    if (running) return running;
    const p = fn()
      .then((value) => {
        if (value.length > 0) {
          store.set(k, { value, at: now() });
          if (store.size > max) store.delete(store.keys().next().value as string);
        }
        return value;
      })
      .finally(() => { if (inflight.get(k) === p) inflight.delete(k); });
    inflight.set(k, p);
    return p;
  }
  return { run, clear: () => { store.clear(); inflight.clear(); }, size: () => store.size };
}

const shared = createSearchCache();
/** App-wide cached search: `cachedSearch("soundcloud", q, () => searchSoundCloud(q))`. */
export const cachedSearch = <T,>(provider: string, q: string, fn: () => Promise<T[]>): Promise<T[]> =>
  (shared as ReturnType<typeof createSearchCache<T>>).run(provider, q, fn);

/**
 * Stream-URL resolver with a short-lived cache, in-flight de-duplication and
 * batched prefetch. Pure (no React, no network of its own): the caller injects
 * the per-provider resolvers, so this is unit-testable.
 *
 * Why: next/previous used to wait on a fresh network round-trip every time, and
 * each song change fired several separate resolutions (a burst that can exhaust
 * the edge function's rate limit when skipping through songs, which then reads
 * as "unavailable"/"buggy"). Resolved URLs are signed and short-lived, so the
 * TTL is deliberately conservative and `invalidate()` exists for retry-on-error.
 */
export interface ResolverDeps<P extends string = string> {
  resolveOne: (provider: P, id: string, opts?: { fresh?: boolean }) => Promise<string | null>;
  /** Return null when the provider has no batch endpoint. Must not throw (but if it does, we fall back to singles). */
  resolveBatch?: (provider: P, ids: string[]) => Promise<Record<string, string | null>> | null;
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
}
export interface PrefetchItem<P extends string = string> { provider: P; id: string }

export function createStreamResolver<P extends string = string>(deps: ResolverDeps<P>) {
  const now = deps.now ?? (() => Date.now());
  const ttl = deps.ttlMs ?? 5 * 60_000;
  const max = deps.maxEntries ?? 80;
  const cache = new Map<string, { url: string; at: number }>();
  const inflight = new Map<string, Promise<string | null>>();
  const key = (p: P, id: string) => `${p}:${id}`;

  const store = (k: string, url: string | null) => {
    if (!url) { cache.delete(k); return; }
    cache.set(k, { url, at: now() });
    if (cache.size > max) cache.delete(cache.keys().next().value as string);
  };
  const fresh = (k: string): string | null => {
    const hit = cache.get(k);
    return hit && now() - hit.at < ttl ? hit.url : null;
  };

  function resolve(provider: P, id: string, opts?: { fresh?: boolean }): Promise<string | null> {
    const k = key(provider, id);
    if (!opts?.fresh) {
      const hit = fresh(k);
      if (hit) return Promise.resolve(hit);
      const running = inflight.get(k);
      if (running) return running;
    }
    const p = deps.resolveOne(provider, id, opts)
      .then((url) => { store(k, url); return url; })
      .catch(() => null)
      .finally(() => { if (inflight.get(k) === p) inflight.delete(k); });
    inflight.set(k, p);
    return p;
  }

  /** Warm the cache for several tracks. Resolves when all are settled; never rejects. */
  async function prefetch(items: PrefetchItem<P>[]): Promise<void> {
    const need = new Map<P, string[]>();
    for (const { provider, id } of items) {
      const k = key(provider, id);
      if (fresh(k) || inflight.has(k)) continue;
      const list = need.get(provider) ?? [];
      if (!list.includes(id)) list.push(id);
      need.set(provider, list);
    }
    const jobs: Promise<unknown>[] = [];
    for (const [provider, ids] of need) {
      const batch = ids.length > 1 ? deps.resolveBatch?.(provider, ids) ?? null : null;
      if (!batch) { for (const id of ids) jobs.push(resolve(provider, id)); continue; }
      // One shared promise per id so concurrent resolve() calls join the batch instead of duplicating it.
      const settled = Promise.resolve(batch).catch(() => ({} as Record<string, string | null>));
      for (const id of ids) {
        const k = key(provider, id);
        const p = settled.then(async (map) => {
          const url = map[id] ?? null;
          if (url) { store(k, url); return url; }
          // The batch missed this id (or failed entirely): fall back to a single resolution.
          return deps.resolveOne(provider, id).then((u) => { store(k, u); return u; }).catch(() => null);
        }).finally(() => { if (inflight.get(k) === p) inflight.delete(k); });
        inflight.set(k, p);
        jobs.push(p);
      }
    }
    await Promise.all(jobs);
  }

  return {
    resolve,
    prefetch,
    /** Cached URL if still fresh, else null (never triggers a request). */
    peek: (provider: P, id: string): string | null => fresh(key(provider, id)),
    invalidate: (provider: P, id: string): void => { cache.delete(key(provider, id)); },
    /** Forget every cached URL of one provider (e.g. when proxy mode flips and old URLs become the wrong kind). */
    clearProvider: (provider: P): void => {
      const prefix = `${provider}:`;
      for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k);
    },
    size: (): number => cache.size,
  };
}

/**
 * Native player state events can say "paused" while ExoPlayer is merely
 * buffering (isPlaying is false then). Before believing a "paused" event,
 * re-read the engine's real state: only these mean the user-visible player is
 * genuinely not playing. `null` (couldn't read) trusts the event.
 */
export function isGenuinePause(state: { state?: string } | null | undefined): boolean {
  if (!state?.state) return true;
  return state.state === "paused" || state.state === "ended" || state.state === "idle";
}

/**
 * Bounded, provider-aware prewarming of stream URLs (pure; no React/network of its own).
 *
 * Why: warmStreams() only ever warmed SoundCloud, although the shared resolver also serves Audius and
 * Jamendo. But an unbounded fan-out (one request per result per keystroke) would burn the edge functions'
 * rate limit — the very thing that makes real taps read as "unavailable". So:
 *  - hard per-provider and total caps (SoundCloud is ONE batch request; Audius/Jamendo are one request each);
 *  - dedupe by provider:id, skip cached / local / non-streamable / offline;
 *  - a generation counter: a newer warm request or a user tap supersedes queued speculative lookups
 *    (requests already on the wire cannot be recalled, but nothing further is started);
 *  - the tapped track is never queued behind warming — the resolver shares in-flight work, so a tap joins it.
 */
export interface WarmTrackLike {
  provider: string;
  providerTrackId: string;
  isStreamable?: boolean;
  streamUrl?: string | null;
}
export interface WarmTarget { provider: string; id: string }

export const WARM_CAPS: Record<string, number> = { soundcloud: 4, audius: 2, jamendo: 2 };
export const WARM_TOTAL_CAP = 6;

export function planWarmTargets(
  tracks: readonly WarmTrackLike[],
  peek: (provider: string, id: string) => string | null,
  online = true,
  caps: Record<string, number> = WARM_CAPS,
  totalCap = WARM_TOTAL_CAP,
): WarmTarget[] {
  if (!online) return [];
  const taken: Record<string, number> = {};
  const seen = new Set<string>();
  const out: WarmTarget[] = [];
  for (const t of tracks) {
    if (out.length >= totalCap) break;
    const cap = caps[t.provider];
    if (!cap || !t.providerTrackId || t.isStreamable === false || t.streamUrl) continue;
    const k = `${t.provider}:${t.providerTrackId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if ((taken[t.provider] ?? 0) >= cap) continue;
    if (peek(t.provider, t.providerTrackId)) continue;
    taken[t.provider] = (taken[t.provider] ?? 0) + 1;
    out.push({ provider: t.provider, id: t.providerTrackId });
  }
  return out;
}

export interface WarmRunnerDeps {
  peek: (provider: string, id: string) => string | null;
  /** Resolve one provider's ids (batched for SoundCloud by the resolver). Must not throw. */
  prefetch: (items: WarmTarget[]) => Promise<void>;
  isOnline?: () => boolean;
  now?: () => number;
  sameSetGapMs?: number;
}

export function createWarmRunner(deps: WarmRunnerDeps) {
  const now = deps.now ?? (() => Date.now());
  const gap = deps.sameSetGapMs ?? 60_000;
  let generation = 0;
  let lastKey = "";
  let lastAt = 0;

  /** Supersede any queued speculative lookups (call when the user taps a track or a newer query arrives). */
  const cancel = (): void => { generation += 1; };

  const warm = (tracks: readonly WarmTrackLike[]): void => {
    const online = deps.isOnline ? deps.isOnline() : true;
    const targets = planWarmTargets(tracks, deps.peek, online);
    if (targets.length === 0) return;
    const key = targets.map((x) => `${x.provider}:${x.id}`).join(",");
    if (key === lastKey && now() - lastAt < gap) return;
    lastKey = key; lastAt = now();
    const gen = ++generation;
    // SoundCloud first (one batch request); the per-track providers are started one at a time and only
    // while this run is still the newest, so a tap / newer query stops the tail.
    const sc = targets.filter((t) => t.provider === "soundcloud");
    const singles = targets.filter((t) => t.provider !== "soundcloud");
    void (async () => {
      try {
        if (sc.length) await deps.prefetch(sc);
        for (const t of singles) {
          if (gen !== generation) return;
          await deps.prefetch([t]);
        }
      } catch { /* warming is best-effort */ }
    })();
  };

  return { warm, cancel, generation: () => generation };
}

/** How many upcoming playable tracks auto-next keeps resolved ahead of the current one. */
export const LEAD_TARGETS = 2;

/**
 * Auto-next "playable lead": after a top-up lands, which of the next queue entries should have their stream URL
 * resolved NOW so the hand-over is not waiting on the network. Queue length alone proves nothing — a suggestion is
 * only metadata until it has a stream. Order mode only (shuffle's real next tracks come from the shuffle chain, which
 * the native-window sync already prefetches). Offline, cached, in-hand streamUrl, YouTube and local entries are
 * skipped by planWarmTargets, so the result is at most `n` real requests (one SoundCloud batch at most).
 */
export function planLeadTargets(
  queue: readonly (WarmTrackLike & { id: string })[],
  currentId: string | undefined,
  peek: (provider: string, id: string) => string | null,
  opts: { online?: boolean; shuffle?: boolean; n?: number } = {},
): WarmTarget[] {
  if (opts.shuffle) return [];
  const n = opts.n ?? LEAD_TARGETS;
  const i = currentId === undefined ? -1 : queue.findIndex((x) => x.id === currentId);
  const upcoming = i < 0 ? queue : queue.slice(i + 1);
  return planWarmTargets(upcoming, peek, opts.online ?? true, WARM_CAPS, n);
}

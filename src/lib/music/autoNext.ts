/**
 * Auto-next suggestions — "what should play after the queue runs out".
 *
 * NOTHING here is a hardcoded query or playlist. Every search seed is
 * derived from what the user actually does:
 *   - the track that is playing right now (its artist / title), and
 *   - a taste profile built from the play log (playHistory.ts): artists
 *     you play a lot and recently score up, artists whose tracks you skip
 *     early score down, and older plays fade with a half-life.
 *
 * Candidates come from the providers the app already has (SoundCloud,
 * Audius, YouTube via music-search), are filtered for junk (mixes,
 * karaoke, reactions…), de-duplicated against everything already played or
 * queued, scored, and finally diversified so one artist can't fill the
 * batch. The pure parts (taste, seeds, ranking) take an injectable
 * `random`/`now` so they are deterministic under test.
 */
import type { GroicTrack } from "./types";
import { isNativelyStreamable } from "./types";
import { songKey } from "./queueQuality";
import { getRecentlyPlayedKeys, readPlayLog, type PlayLogEntry } from "./playHistory";

// ── Identity helpers ────────────────────────────────────────────────────────

/** songKey strips everything outside a-z0-9, so titles in Devanagari,
 *  Arabic, Hangul… all collapse to "" — which would make every such track
 *  look like a duplicate of every other. Fall back to the raw title. */
export const trackKey = (t: Pick<GroicTrack, "title">): string =>
  songKey(t.title) || t.title.toLowerCase().trim();

/** YouTube channel names carry upload noise ("Adele - Topic", "AdeleVEVO",
 *  "Adele Official"); reduce to the artist. */
export const cleanArtist = (raw: string): string =>
  (raw || "")
    .replace(/\s*[-–—]\s*topic$/i, "")
    .replace(/\s*vevo$/i, "")
    .replace(/\s+official(\s+(channel|artist channel|music))?$/i, "")
    .replace(/\s+/g, " ")
    .trim();

export const artistKey = (raw: string): string =>
  cleanArtist(raw).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const UNKNOWN_ARTIST_RE = /^(unknown( artist)?|various( artists)?|n\/a|none|-|)$/i;
const isUsableArtist = (raw: string): boolean => !UNKNOWN_ARTIST_RE.test(cleanArtist(raw));

// ── Taste profile ───────────────────────────────────────────────────────────

export interface ArtistAffinity {
  key: string;
  /** Display name (most recent spelling seen). */
  name: string;
  score: number;
}

const HALF_LIFE_DAYS = 14;
const SKIP_WEIGHT = 1.5;
/** A track listened through to the end is a stronger "like" than a bare play. */
const COMPLETE_WEIGHT = 1.5;
const DAY_MS = 86_400_000;

/** Recency-decayed artist scores. A play adds 1, a full listen adds
 *  {@link COMPLETE_WEIGHT}, an early skip subtracts {@link SKIP_WEIGHT}; all fade with a {@link HALF_LIFE_DAYS} half-life.
 *  Only artists with a positive net score are returned, best first. */
export function buildTaste(log: readonly PlayLogEntry[], now: number = Date.now()): ArtistAffinity[] {
  const byArtist = new Map<string, ArtistAffinity>();
  for (const e of log) {
    if (!isUsableArtist(e.artist)) continue;
    const key = artistKey(e.artist);
    if (!key) continue;
    const ageDays = Math.max(0, (now - e.at) / DAY_MS);
    const decay = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
    const delta = (e.skipped ? -SKIP_WEIGHT : e.done ? COMPLETE_WEIGHT : 1) * decay;
    const prev = byArtist.get(key);
    if (prev) prev.score += delta;
    else byArtist.set(key, { key, name: cleanArtist(e.artist), score: delta });
  }
  return [...byArtist.values()].filter((a) => a.score > 0.05).sort((a, b) => b.score - a.score);
}

/** Weighted random pick (by score) without replacement. */
function weightedSample<T extends { score: number }>(items: T[], n: number, random: () => number): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (out.length < n && pool.length > 0) {
    const total = pool.reduce((s, x) => s + x.score, 0);
    let r = random() * total;
    let idx = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      r -= pool[i].score;
      if (r <= 0) { idx = i; break; }
    }
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

// ── Seed queries ────────────────────────────────────────────────────────────

/** Search seeds for "more like this", all derived from listening data:
 *  1. the current track's artist,
 *  2. up to two other artists sampled (by affinity) from the taste profile,
 *  3. cold start with no usable artist anywhere → the current title itself.
 *  Returns [] when there is nothing to go on (brand-new user, nothing
 *  playing) — the caller then simply has no suggestions rather than
 *  inventing some. */
export function buildSeedQueries(
  current: Pick<GroicTrack, "title" | "artist"> | null,
  taste: readonly ArtistAffinity[],
  opts: { maxSeeds?: number; random?: () => number } = {},
): string[] {
  const maxSeeds = opts.maxSeeds ?? 3;
  const random = opts.random ?? Math.random;
  const seeds: string[] = [];
  const seen = new Set<string>();
  const add = (q: string) => {
    const k = q.toLowerCase().trim();
    if (k && !seen.has(k) && seeds.length < maxSeeds) { seen.add(k); seeds.push(q.trim()); }
  };

  const curArtist = current && isUsableArtist(current.artist) ? cleanArtist(current.artist) : "";
  if (curArtist) add(curArtist);

  const curKey = curArtist ? artistKey(curArtist) : "";
  const others = taste.filter((a) => a.key !== curKey);
  for (const a of weightedSample([...others], Math.max(0, maxSeeds - seeds.length), random)) add(a.name);

  if (seeds.length === 0 && current) {
    const t = songKey(current.title) || current.title.trim();
    if (t) add(t);
  }
  return seeds;
}

// ── Ranking ─────────────────────────────────────────────────────────────────

// Never a sensible "next song": long mixes, karaoke, reactions, tutorials.
const HARD_REJECT_RE = /\b(karaoke|reaction|reacts?|tutorial|lesson|podcast|full album|non[\s-]?stop|jukebox|\d+\s*(hours?|hrs?)|nightcore)\b/i;
// Legit but usually not what "play next" means — only if the current track is one too.
const VERSION_RE = /\b(cover|remix|mashup|slowed|reverb|sped up|8d|bass boosted|lofi flip)\b/i;

const MIN_SECONDS = 60;
const MAX_SECONDS = 15 * 60;

export interface RankContext {
  current: Pick<GroicTrack, "id" | "title" | "artist"> | null;
  /** trackKey()s that must not come back: recent plays + current queue. */
  excludeKeys: ReadonlySet<string>;
  taste: readonly ArtistAffinity[];
  /** artistKey()s of the last few tracks played, newest first — used to
   *  avoid artist runs. */
  recentArtists?: readonly string[];
  random?: () => number;
}

export function rankCandidates(candidates: readonly GroicTrack[], ctx: RankContext, limit = 10): GroicTrack[] {
  const random = ctx.random ?? Math.random;
  const curTitle = ctx.current?.title ?? "";
  const curIsVersion = VERSION_RE.test(curTitle);
  const curArtistKey = ctx.current ? artistKey(ctx.current.artist) : "";
  const affinity = new Map(ctx.taste.map((a) => [a.key, a.score]));
  const recent = new Set((ctx.recentArtists ?? []).slice(0, 3));

  const seenKeys = new Set<string>();
  const scored: { t: GroicTrack; score: number; artist: string }[] = [];

  for (const t of candidates) {
    if (!t.title || !t.id) continue;
    if (t.isStreamable === false) continue;
    if (ctx.current && t.id === ctx.current.id) continue;
    const key = trackKey(t);
    if (!key || ctx.excludeKeys.has(key) || seenKeys.has(key)) continue;
    if (HARD_REJECT_RE.test(t.title)) continue;
    if (t.duration > 0 && (t.duration < MIN_SECONDS || t.duration > MAX_SECONDS)) continue;
    seenKeys.add(key);

    const aKey = artistKey(t.artist);
    let score = 0;
    score += Math.min(3, Math.max(0, affinity.get(aKey) ?? 0));          // taste
    if (aKey && aKey === curArtistKey) score += 1.5;                      // "more from this artist"
    if (isNativelyStreamable(t)) score += 0.3;                            // plays in the background/lock screen
    if (VERSION_RE.test(t.title) && !curIsVersion) score -= 2.5;          // covers/remixes only if you're already in one
    if (aKey && recent.has(aKey)) score -= 1.2;                           // don't loop the same few artists
    score += random() * 0.8;                                              // variety
    scored.push({ t, score, artist: aKey });
  }

  scored.sort((a, b) => b.score - a.score);

  // Diversify: at most 2 per artist on the first pass, leftovers fill the rest.
  const out: GroicTrack[] = [];
  const perArtist = new Map<string, number>();
  const leftovers: GroicTrack[] = [];
  for (const s of scored) {
    const n = perArtist.get(s.artist) ?? 0;
    if (s.artist && n >= 2) { leftovers.push(s.t); continue; }
    perArtist.set(s.artist, n + 1);
    out.push(s.t);
    if (out.length >= limit) return out;
  }
  for (const t of leftovers) {
    if (out.length >= limit) break;
    out.push(t);
  }
  return out;
}

// ── Fetching ────────────────────────────────────────────────────────────────

export interface AutoNextDeps {
  searchSoundCloud: (q: string) => Promise<GroicTrack[]>;
  searchAudius: (q: string) => Promise<GroicTrack[]>;
  searchYouTube: (q: string) => Promise<GroicTrack[]>;
}

const defaultDeps = async (): Promise<AutoNextDeps> => {
  const [{ searchSoundCloud }, { searchAudius }, { youtubeResultToTrack }, { invokeEdgeFunction }] = await Promise.all([
    import("./soundcloudProvider"),
    import("./audiusProvider"),
    import("./youtubeProvider"),
    import("@/lib/edgeFunction"),
  ]);
  return {
    searchSoundCloud,
    searchAudius,
    searchYouTube: async (query) => {
      const data = await invokeEdgeFunction<{ results?: Parameters<typeof youtubeResultToTrack>[0][] }>(
        "music-search", { body: { query } },
      );
      return (Array.isArray(data?.results) ? data!.results! : [])
        .filter((r) => r && r.videoId && r.title)
        .map(youtubeResultToTrack);
    },
  };
};

// Same query twice within a few minutes (queue top-up then end-of-queue
// advance, or two quick skips) shouldn't re-hit three edge functions.
const QUERY_CACHE_TTL_MS = 10 * 60_000;
const queryCache = new Map<string, { at: number; tracks: GroicTrack[] }>();
/** Test hook. */
export const __clearAutoNextCache = () => queryCache.clear();

async function searchAllProviders(q: string, deps: AutoNextDeps, now: number): Promise<GroicTrack[]> {
  const hit = queryCache.get(q.toLowerCase());
  if (hit && now - hit.at < QUERY_CACHE_TTL_MS) return hit.tracks;
  const safe = (p: Promise<GroicTrack[]>) => p.catch(() => [] as GroicTrack[]);
  const [sc, au, yt] = await Promise.all([
    safe(deps.searchSoundCloud(q)),
    safe(deps.searchAudius(q)),
    safe(deps.searchYouTube(q)),
  ]);
  const tracks = [...sc, ...au, ...yt];
  if (tracks.length > 0) queryCache.set(q.toLowerCase(), { at: now, tracks });
  return tracks;
}

export interface AutoNextInput {
  /** What's playing (or null, e.g. for the home "for you" rail). */
  current: GroicTrack | null;
  /** The live queue — everything in it is excluded from suggestions. */
  queue: readonly GroicTrack[];
  limit?: number;
  maxSeeds?: number;
  /** Injectables for tests. */
  now?: number;
  random?: () => number;
  log?: readonly PlayLogEntry[];
  recentKeys?: ReadonlySet<string>;
}

/** Fetch, filter, score and diversify suggestions. Never throws; resolves
 *  to [] when there's no signal or every provider fails. */
export async function fetchAutoNext(input: AutoNextInput, deps?: AutoNextDeps): Promise<GroicTrack[]> {
  try {
    const now = input.now ?? Date.now();
    const random = input.random ?? Math.random;
    const log = input.log ?? readPlayLog();
    const taste = buildTaste(log, now);
    const seeds = buildSeedQueries(input.current, taste, { maxSeeds: input.maxSeeds, random });
    if (seeds.length === 0) return [];

    const d = deps ?? (await defaultDeps());
    const batches = await Promise.all(seeds.map((q) => searchAllProviders(q, d, now)));
    const candidates = batches.flat();

    const exclude = new Set<string>(input.recentKeys ?? getRecentlyPlayedKeys());
    for (const t of input.queue) exclude.add(trackKey(t));
    if (input.current) exclude.add(trackKey(input.current));

    return rankCandidates(candidates, {
      current: input.current,
      excludeKeys: exclude,
      taste,
      recentArtists: log.map((e) => artistKey(e.artist)).filter(Boolean),
      random,
    }, input.limit ?? 10);
  } catch {
    return [];
  }
}

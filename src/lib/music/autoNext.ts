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
import { trackKey as sharedTrackKey, sameNameFamily } from "./queueQuality";
import { getMusicPrefs, getRecentlyPlayedKeys, readPlayLog, type PlayLogEntry } from "./playHistory";

// ── Identity helpers ────────────────────────────────────────────────────────

/** songKey strips everything outside a-z0-9, so titles in Devanagari,
 *  Arabic, Hangul… all collapse to "" — which would make every such track
 *  look like a duplicate of every other. Fall back to the raw title. */
export const trackKey = (t: Pick<GroicTrack, "title">): string => sharedTrackKey(t.title);

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
// Labels / uploader channels are not artists: searching "T-Series" returns
// random label uploads, and one T-Series play must not make "T-Series" a taste
// seed. (This was a source of "next song is nothing I listen to".)
const LABEL_ARTIST_RE = /(t[\s-]?series|zee music|sony music|speed records|saregama|tips (official|music|films)|times music|lahari|aditya music|wave music|white hill|desi melodies|eros now|(^|\s)(records|recordings|music company|entertainment|studios|films|network|channel)$)/i;
const isUsableArtist = (raw: string): boolean => {
  const c = cleanArtist(raw);
  return !UNKNOWN_ARTIST_RE.test(c) && !LABEL_ARTIST_RE.test(c);
};

/** Writing system of a string — lets a Devanagari/Gurmukhi/… listener keep
 *  getting songs in their own script instead of an unrelated language.
 *  Latin is "latin" (transliterated Hindi can't be told from English). */
const SCRIPTS: ReadonlyArray<readonly [string, RegExp]> = [
  ["devanagari", /[\u0900-\u097F]/], ["gurmukhi", /[\u0A00-\u0A7F]/], ["bengali", /[\u0980-\u09FF]/],
  ["gujarati", /[\u0A80-\u0AFF]/], ["tamil", /[\u0B80-\u0BFF]/], ["telugu", /[\u0C00-\u0C7F]/],
  ["kannada", /[\u0C80-\u0CFF]/], ["malayalam", /[\u0D00-\u0D7F]/], ["arabic", /[\u0600-\u06FF]/],
  ["cyrillic", /[\u0400-\u04FF]/], ["hangul", /[\uAC00-\uD7AF]/], ["cjk", /[\u3040-\u30FF\u4E00-\u9FFF]/],
];
export const scriptOf = (text: string): string => {
  for (const [name, re] of SCRIPTS) if (re.test(text || "")) return name;
  return "latin";
};

// ── Taste profile ───────────────────────────────────────────────────────────

export interface ArtistAffinity {
  key: string;
  /** Display name (most recent spelling seen). */
  name: string;
  score: number;
}

const HALF_LIFE_DAYS = 14;
/** An artist is only a "taste" (used to seed suggestions / counted as related)
 *  once their decayed score is at least about one recent play. A single stray
 *  play months ago must not steer what plays next. */
const MIN_AFFINITY = 0.6;
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

/** Part of the day a timestamp falls in (local time). */
export const dayPartOf = (ms: number): "night" | "morning" | "afternoon" | "evening" => {
  const h = new Date(ms).getHours();
  return h < 5 ? "night" : h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
};

/** artistKey -> 0..1: how much the listener plays this artist at THIS time of day (finished/plain plays
 *  in the same day-part; skips don't count). Needs 2+ plays before it means anything. */
export function buildTimeAffinity(log: readonly PlayLogEntry[], now: number = Date.now()): Map<string, number> {
  const part = dayPartOf(now);
  const counts = new Map<string, number>();
  for (const e of log) {
    if (e.skipped || !isUsableArtist(e.artist) || dayPartOf(e.at) !== part) continue;
    const key = artistKey(e.artist);
    if (key) counts.set(key, (counts.get(key) ?? 0) + (e.done ? 1.3 : 1));
  }
  const out = new Map<string, number>();
  for (const [k, n] of counts) if (n >= 2) out.set(k, Math.min(1, (n - 1) * 0.25));
  return out;
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
 *  1. the current track's artist (not a label/channel),
 *  2. up to two other artists sampled (by affinity) from the taste profile.
 *  Returns [] when there is nothing to go on — the caller then falls back to
 *  language trending (or has no suggestions) rather than inventing some. */
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
  const others = taste.filter((a) => a.key !== curKey && a.score >= MIN_AFFINITY);
  for (const a of weightedSample([...others], Math.max(0, maxSeeds - seeds.length), random)) add(a.name);

  // No artist-less title fallback on purpose: searching the song's own TITLE
  // returns every song with that word in it ("payal" → all "payal" songs).
  // With no usable artist and no taste, fetchAutoNext goes straight to the
  // language-trending step instead.
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
  /** trackKey()s of the last few songs played (newest first). Anything in the
   *  same NAME FAMILY as the current or these is rejected outright, so the
   *  next song is never "Payal" again right after "Payal". */
  recentTitleKeys?: readonly string[];
  /** artistKey()s of the artists the search seeds were built from. */
  seedArtists?: readonly string[];
  /** Drop candidates unrelated to the current artist / taste / seeds instead
   *  of merely ranking them last. */
  relatedOnly?: boolean;
  /** artistKey -> number of liked songs by them. A liked artist always counts as "related" and is boosted. */
  likedArtists?: ReadonlyMap<string, number>;
  /** artistKey -> 0..1 affinity for the current time of day (buildTimeAffinity). */
  timeAffinity?: ReadonlyMap<string, number>;
  random?: () => number;
}

/** Candidate is plausibly "something this listener asked for": same artist as
 *  now playing, an artist they actually play, or the artist a seed searched. */
const isRelated = (aKey: string, curArtistKey: string, affinity: Map<string, number>, seeds: ReadonlySet<string>): boolean => {
  if (!aKey) return false;
  if (aKey === curArtistKey) return true;
  if ((affinity.get(aKey) ?? 0) >= MIN_AFFINITY) return true;
  if (seeds.has(aKey)) return true;
  // Featured-artist credits ("Arijit Singh, Shreya Ghoshal") still count.
  for (const s of seeds) if (s && (aKey.includes(s) || s.includes(aKey)) && Math.min(aKey.length, s.length) >= 4) return true;
  return false;
};

export function rankCandidates(candidates: readonly GroicTrack[], ctx: RankContext, limit = 10): GroicTrack[] {
  const random = ctx.random ?? Math.random;
  const curTitle = ctx.current?.title ?? "";
  const curIsVersion = VERSION_RE.test(curTitle);
  const curArtistKey = ctx.current ? artistKey(ctx.current.artist) : "";
  const affinity = new Map(ctx.taste.map((a) => [a.key, a.score]));
  // Songs you explicitly liked are the strongest taste signal: their artists are always "related".
  for (const k of ctx.likedArtists?.keys() ?? []) affinity.set(k, Math.max(affinity.get(k) ?? 0, MIN_AFFINITY));
  const recent = new Set((ctx.recentArtists ?? []).slice(0, 3));
  const seedSet = new Set(ctx.seedArtists ?? []);
  const familyKeys = [
    ...(ctx.current ? [trackKey(ctx.current)] : []),
    ...(ctx.recentTitleKeys ?? []).slice(0, 5),
  ].filter(Boolean);
  const curScript = ctx.current ? scriptOf(`${ctx.current.title} ${ctx.current.artist}`) : "latin";

  const seenKeys = new Set<string>();
  const scored: { t: GroicTrack; score: number; artist: string }[] = [];

  for (const t of candidates) {
    if (!t.title || !t.id) continue;
    if (t.isStreamable === false) continue;
    if (ctx.current && t.id === ctx.current.id) continue;
    const key = trackKey(t);
    if (!key || ctx.excludeKeys.has(key) || seenKeys.has(key)) continue;
    if (HARD_REJECT_RE.test(t.title)) continue;
    if (familyKeys.some((fk) => sameNameFamily(key, fk))) continue;   // same-name family of what just played
    if (t.duration > 0 && (t.duration < MIN_SECONDS || t.duration > MAX_SECONDS)) continue;
    seenKeys.add(key);

    const aKey = artistKey(t.artist);
    const related = isRelated(aKey, curArtistKey, affinity, seedSet);
    if (ctx.relatedOnly && !related) continue;
    let score = 0;
    if (!related) score -= 2.5;                                           // unrelated fuzzy search hit: last resort only
    if (curScript !== "latin") score += scriptOf(`${t.title} ${t.artist}`) === curScript ? 1 : -1.5; // stay in the listener's script
    score += Math.min(3, Math.max(0, affinity.get(aKey) ?? 0));          // taste
    score += Math.min(1.5, (ctx.likedArtists?.get(aKey) ?? 0) * 0.5);   // liked songs by this artist
    score += (ctx.timeAffinity?.get(aKey) ?? 0) * 0.8;                   // "you play them at this time of day"
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
  /** Language-trending candidates — the last-resort source when the
   *  artist/taste seeds run dry. Optional so existing callers/tests that
   *  only inject the three searches keep working. */
  searchTrending?: (langId: string) => Promise<GroicTrack[]>;
}

const defaultDeps = async (): Promise<AutoNextDeps> => {
  const [{ searchSoundCloud }, { searchAudius }, { youtubeResultToTrack }, { invokeEdgeFunction }, { getTrendingRail }] = await Promise.all([
    import("./soundcloudProvider"),
    import("./audiusProvider"),
    import("./youtubeProvider"),
    import("@/lib/edgeFunction"),
    import("./trendingMix"),
  ]);
  return {
    searchTrending: (langId) => getTrendingRail(langId, 20),
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

/** Liked artists join the taste profile (so they also seed searches), weighted by how many songs were liked. */
export function withLikedTaste(taste: readonly ArtistAffinity[], liked: ReadonlyMap<string, number>): ArtistAffinity[] {
  const byKey = new Map<string, ArtistAffinity>(taste.map((a): [string, ArtistAffinity] => [a.key, { ...a }]));
  for (const [key, n] of liked) {
    const boost = Math.min(3, n * 0.75);
    const prev = byKey.get(key);
    if (prev) prev.score += boost;
    else byKey.set(key, { key, name: key, score: boost });
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score);
}

/** Liked Songs -> artistKey counts. Never throws (storage blocked / tests without localStorage -> empty). */
async function loadLikedArtists(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const { readLiked } = await import("./libraryStore");
    for (const t of readLiked()) {
      if (!isUsableArtist(t.artist)) continue;
      const k = artistKey(t.artist);
      if (k) out.set(k, (out.get(k) ?? 0) + 1);
    }
  } catch { /* no liked data available */ }
  return out;
}

export interface AutoNextInput {
  /** What's playing (or null, e.g. for the home "for you" rail). */
  current: GroicTrack | null;
  /** The live queue — everything in it is excluded from suggestions. */
  queue: readonly GroicTrack[];
  limit?: number;
  maxSeeds?: number;
  /** Language ids (trendingMix) used by the last-resort fallback. Defaults
   *  to the user's saved language chips, else Hindi + English. */
  langs?: readonly string[];
  /** Injectables for tests. */
  now?: number;
  random?: () => number;
  log?: readonly PlayLogEntry[];
  recentKeys?: ReadonlySet<string>;
  /** artistKey -> liked-song count. Defaults to the person's Liked Songs. */
  likedArtists?: ReadonlyMap<string, number>;
}

/** How many of the newest played songs stay excluded even when the strict
 *  "not played recently" window has to be relaxed to find enough tracks. */
const ALWAYS_EXCLUDE_NEWEST = 10;

/** Fetch, filter, score and diversify suggestions. Never throws; resolves
 *  to [] when there's no signal or every provider fails.
 *
 *  A fallback LADDER keeps playback from silently stopping when the first,
 *  strictest pass comes back short (this used to be the "auto-next just
 *  stops / only gives 1-2 songs" failure — one pass, then nothing):
 *    1. strict   — seeds from the current artist + taste, nothing recently
 *                  played or queued;
 *    2. relaxed  — same candidates, but only the newest plays stay
 *                  excluded (a song from last week may come back);
 *    3. language — trending for the user's chosen languages, so a Hindi /
 *                  Punjabi / … listener keeps getting their language even
 *                  when the artist search is thin. Only when something is
 *                  actually playing (the home "Made for you" rail passes
 *                  current = null and stays empty for brand-new users). */
export async function fetchAutoNext(input: AutoNextInput, deps?: AutoNextDeps): Promise<GroicTrack[]> {
  try {
    const now = input.now ?? Date.now();
    const random = input.random ?? Math.random;
    const limit = input.limit ?? 10;
    const log = input.log ?? readPlayLog();
    const likedArtists = input.likedArtists ?? (await loadLikedArtists());
    const taste = withLikedTaste(buildTaste(log, now), likedArtists);
    const timeAffinity = buildTimeAffinity(log, now);
    const seeds = buildSeedQueries(input.current, taste, { maxSeeds: input.maxSeeds, random });
    // Nothing playing and nothing to seed from → genuinely no signal.
    if (seeds.length === 0 && !input.current) return [];

    const d = deps ?? (await defaultDeps());
    const batches = await Promise.all(seeds.map((q) => searchAllProviders(q, d, now)));
    const candidates = batches.flat();

    const queueKeys = new Set<string>();
    for (const t of input.queue) queueKeys.add(trackKey(t));
    if (input.current) queueKeys.add(trackKey(input.current));

    const recentAll = [...(input.recentKeys ?? getRecentlyPlayedKeys())]; // newest first
    const recentArtists = log.map((e) => artistKey(e.artist)).filter(Boolean);
    const seedArtists = seeds.map(artistKey).filter(Boolean);
    const rank = (cands: readonly GroicTrack[], exclude: Set<string>, n: number, relatedOnly: boolean) =>
      rankCandidates(cands, {
        current: input.current, excludeKeys: exclude, taste, recentArtists, random,
        recentTitleKeys: recentAll, seedArtists, relatedOnly, likedArtists, timeAffinity,
      }, n);

    const out: GroicTrack[] = [];
    const have = new Set<string>();
    const take = (batch: readonly GroicTrack[]) => {
      for (const t of batch) {
        const k = trackKey(t);
        if (!k || have.has(k) || out.length >= limit) continue;
        have.add(k); out.push(t);
      }
    };
    const enough = Math.min(limit, 6);
    const strictExclude = () => new Set([...queueKeys, ...recentAll, ...have]);
    const relaxedExclude = () => new Set([...queueKeys, ...recentAll.slice(0, ALWAYS_EXCLUDE_NEWEST), ...have]);

    // 1. strict + related only: the current artist, artists you actually play,
    //    or the artist a seed searched. Fuzzy search noise is NOT allowed in.
    take(rank(candidates, strictExclude(), limit, true));

    // 2. relaxed recent-play window (a song from last week may come back).
    if (out.length < enough) take(rank(candidates, relaxedExclude(), limit, true));

    // 3. language trending, ranked toward the current track's script and your
    //    taste. Ahead of unrelated search hits: a popular song in your own
    //    language beats a random fuzzy match for an artist name.
    if (out.length < enough && input.current && d.searchTrending) {
      const langs = (input.langs ?? getMusicPrefs().langs ?? ["hindi", "english"]).slice(0, 3);
      const pools = await Promise.all(
        langs.map((id) => d.searchTrending!(id).catch(() => [] as GroicTrack[])),
      );
      const pool = pools.flat();
      take(rank(pool, strictExclude(), limit, false));
      if (out.length < enough) take(rank(pool, relaxedExclude(), limit, false));
    }

    // 4. last resort so playback does not just stop: anything from the seed
    //    searches (still never the same-name family — that is a hard filter).
    if (out.length < Math.min(limit, 2)) {
      take(rank(candidates, relaxedExclude(), limit, false));
    }
    return out;
  } catch {
    return [];
  }
}

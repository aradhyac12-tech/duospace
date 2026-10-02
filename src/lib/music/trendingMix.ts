/**
 * Mixed, randomized trending per language.
 *
 * WHY: trending used to come ONLY from YouTube with `order=viewCount` — i.e.
 * the all-time most-viewed videos for a fixed query — so every open showed
 * the exact same songs in the exact same order. Now each language rail is
 * assembled from three providers in a FIXED PRIORITY of tiers:
 *   1. SoundCloud  2. YouTube  3. Audius
 * Each tier is sampled from a randomly chosen query (from a per-language
 * pool) and shuffled inside itself, so the rail is fresh on every visit
 * while SoundCloud (natively streamable, background-safe) always leads.
 */
import type { GroicTrack } from "@/lib/music/types";
import { searchSoundCloud } from "@/lib/music/soundcloudProvider";
import { searchAudius, trendingAudius } from "@/lib/music/audiusProvider";
import { youtubeResultToTrack, type YouTubeSearchResult } from "@/lib/music/youtubeProvider";
import { invokeEdgeFunction } from "@/lib/edgeFunction";
import { songKey, shuffled } from "@/lib/music/queueQuality";

export interface TrendingLanguage {
  id: string;
  label: string;
  /** Name in its own script, shown under the label. */
  native: string;
  /** Pool of discovery queries; one is picked at random per load. */
  queries: string[];
  audiusGenre?: string;
}

export const TRENDING_LANGUAGES: TrendingLanguage[] = [
  { id: "hindi", label: "Hindi", native: "हिन्दी", queries: ["new hindi songs", "bollywood hits", "latest bollywood songs", "hindi romantic songs new", "arijit singh new song"] },
  { id: "english", label: "English", native: "English", queries: ["top hits", "new pop songs", "trending english songs", "billboard hot 100", "viral songs"], audiusGenre: "Electronic" },
  { id: "punjabi", label: "Punjabi", native: "ਪੰਜਾਬੀ", queries: ["new punjabi songs", "punjabi hits", "latest punjabi song", "punjabi party songs"] },
  { id: "urdu", label: "Urdu", native: "اردو", queries: ["new urdu songs", "coke studio", "pakistani songs new", "urdu ghazal new"] },
  { id: "tamil", label: "Tamil", native: "தமிழ்", queries: ["new tamil songs", "tamil hits", "anirudh new song", "kollywood songs"] },
  { id: "telugu", label: "Telugu", native: "తెలుగు", queries: ["new telugu songs", "tollywood hits", "telugu latest songs"] },
  { id: "bengali", label: "Bengali", native: "বাংলা", queries: ["new bengali songs", "bangla gaan", "bengali romantic songs"] },
  { id: "marathi", label: "Marathi", native: "मराठी", queries: ["new marathi songs", "marathi hits", "marathi dj songs"] },
  { id: "gujarati", label: "Gujarati", native: "ગુજરાતી", queries: ["new gujarati songs", "gujarati garba", "gujarati hits"] },
  { id: "kannada", label: "Kannada", native: "ಕನ್ನಡ", queries: ["new kannada songs", "kannada hits", "sandalwood songs"] },
  { id: "malayalam", label: "Malayalam", native: "മലയാളം", queries: ["new malayalam songs", "malayalam hits", "mollywood songs"] },
  { id: "haryanvi", label: "Haryanvi", native: "हरियाणवी", queries: ["haryanvi songs new", "haryanvi dj", "haryanvi hits"] },
  { id: "bhojpuri", label: "Bhojpuri", native: "भोजपुरी", queries: ["new bhojpuri songs", "bhojpuri hits"] },
  { id: "arabic", label: "Arabic", native: "العربية", queries: ["arabic songs new", "arabic hits", "arabic pop"] },
  { id: "spanish", label: "Spanish", native: "Español", queries: ["reggaeton nuevo", "latin hits", "musica en español"], audiusGenre: "Latin" },
  { id: "korean", label: "K-Pop", native: "한국어", queries: ["kpop new", "kpop hits", "kpop trending"] },
];

const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const CACHE_TTL_MS = 30 * 60_000;
const cache = new Map<string, { at: number; tiers: GroicTrack[][] }>();

async function ytTier(lang: string): Promise<GroicTrack[]> {
  const data = await invokeEdgeFunction<Record<string, YouTubeSearchResult[]>>("music-trending", { body: { languages: [lang] } });
  return (data?.[lang] ?? []).map(youtubeResultToTrack);
}

const safe = (p: Promise<GroicTrack[]>) => p.catch(() => [] as GroicTrack[]);

/** Returns the rail for one language: SC tier → YT tier → Audius tier,
 *  each shuffled, de-duplicated across tiers. Provider data is cached
 *  30 min; the shuffle is redone on every call. */
export async function getTrendingRail(langId: string, limit = 15, force = false): Promise<GroicTrack[]> {
  const lang = TRENDING_LANGUAGES.find(l => l.id === langId);
  if (!lang) return [];
  let entry = cache.get(langId);
  if (force || !entry || Date.now() - entry.at > CACHE_TTL_MS) {
    const [sc, yt, au] = await Promise.all([
      safe(searchSoundCloud(pick(lang.queries))),
      safe(ytTier(langId)),
      safe(lang.id === "english" || lang.audiusGenre ? trendingAudius(lang.audiusGenre) : searchAudius(pick(lang.queries))),
    ]);
    entry = { at: Date.now(), tiers: [sc, yt, au] };
    cache.set(langId, entry);
  }
  // Fixed tier priority, randomized inside each tier; roughly
  // 40% SoundCloud / 40% YouTube / 20% Audius when all have data.
  const quota = [Math.ceil(limit * 0.4), Math.ceil(limit * 0.4), limit];
  const seen = new Set<string>();
  const out: GroicTrack[] = [];
  entry.tiers.forEach((tier, i) => {
    let taken = 0;
    for (const t of shuffled(tier)) {
      if (out.length >= limit || taken >= quota[i]) break;
      const k = songKey(t.title);
      if (seen.has(k)) continue;
      seen.add(k); out.push(t); taken++;
    }
  });
  return out;
}

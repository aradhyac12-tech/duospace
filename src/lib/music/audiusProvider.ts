/**
 * Audius provider adapter — the one provider that can feed the native
 * background-playback engine, since it's the one whose API resolves to a
 * real, directly-playable stream URL (see supabase/functions/audius-search
 * and docs/MUSIC_NATIVE_PLAYBACK.md for the full rationale).
 *
 * All calls go through the `audius-search` edge function — see that
 * function's header for why this is proxied rather than called directly
 * from the client even though Audius's read API needs no secret.
 */
import { invokeEdgeFunction } from "@/lib/edgeFunction";
import { GroicTrack, makeTrackId } from "./types";

interface NormalizedAudiusTrack {
  provider: "audius";
  providerTrackId: string;
  title: string;
  artist: string;
  artwork: string | null;
  duration: number;
  permalink: string | null;
  isStreamable: boolean;
  isDownloadable: boolean;
}

const toGroicTrack = (t: NormalizedAudiusTrack): GroicTrack => ({
  id: makeTrackId("audius", t.providerTrackId),
  provider: "audius",
  providerTrackId: t.providerTrackId,
  videoId: t.providerTrackId, // see types.ts's GroicTrack.videoId doc comment
  title: t.title,
  artist: t.artist,
  thumbnail: t.artwork,
  artwork: t.artwork ?? undefined,
  duration: t.duration,
  permalink: t.permalink ?? undefined,
  isStreamable: t.isStreamable,
  isDownloadable: t.isDownloadable,
});

export async function searchAudius(query: string): Promise<GroicTrack[]> {
  const data = await invokeEdgeFunction<{ results?: NormalizedAudiusTrack[] }>(
    "audius-search", { body: { mode: "search", query } },
  );
  return (data?.results ?? []).map(toGroicTrack);
}

export async function trendingAudius(genre?: string): Promise<GroicTrack[]> {
  const data = await invokeEdgeFunction<{ results?: NormalizedAudiusTrack[] }>(
    "audius-search", { body: { mode: "trending", genre } },
  );
  return (data?.results ?? []).map(toGroicTrack);
}

/**
 * Resolves a track to a playable stream URL, caching the result on the
 * track object itself (`streamUrl`) so replaying the same track — e.g.
 * pressing previous back onto it, or a shared-listening guest resolving
 * the same track the host just loaded — doesn't re-hit the edge function.
 * Returns null (never throws) if the track can't be streamed right now —
 * callers should treat that as "skip/mark unavailable", not a hard error,
 * per the "gracefully skip, never fall back to an illegal source" rule.
 */
export async function resolveAudiusStreamUrl(providerTrackId: string): Promise<string | null> {
  try {
    const data = await invokeEdgeFunction<{ streamUrl?: string | null; error?: string }>(
      "audius-search", { body: { mode: "stream", trackId: providerTrackId } },
    );
    return data?.streamUrl ?? null;
  } catch {
    return null;
  }
}

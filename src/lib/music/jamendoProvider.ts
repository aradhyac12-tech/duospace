/**
 * Jamendo provider adapter — "Free Music". Official API, Creative-Commons
 * licensed tracks, direct MP3 stream URLs, so it is natively streamable and
 * plays in the background through the native engine (see isNativelyStreamable
 * in ./types.ts). All calls go through the `jamendo-search` edge function,
 * which holds the JAMENDO_CLIENT_ID secret. See that file for licence notes.
 */
import { invokeEdgeFunction } from "@/lib/edgeFunction";
import { GroicTrack, makeTrackId } from "./types";

interface NormalizedJamendoTrack {
  provider: "jamendo";
  providerTrackId: string;
  title: string;
  artist: string;
  artwork: string | null;
  duration: number;
  permalink: string | null;
  isStreamable: boolean;
  streamUrl: string | null;
}

const toGroicTrack = (t: NormalizedJamendoTrack): GroicTrack => ({
  id: makeTrackId("jamendo", t.providerTrackId),
  provider: "jamendo",
  providerTrackId: t.providerTrackId,
  videoId: t.providerTrackId, // see types.ts's GroicTrack.videoId doc comment
  title: t.title,
  artist: t.artist,
  thumbnail: t.artwork,
  artwork: t.artwork ?? undefined,
  duration: t.duration,
  permalink: t.permalink ?? undefined,
  isStreamable: t.isStreamable,
  isDownloadable: false,
  // Jamendo's audio URL is long-lived, so it is safe to carry on the track.
  ...(t.streamUrl ? { streamUrl: t.streamUrl } : {}),
});

export async function searchJamendo(query: string): Promise<GroicTrack[]> {
  const data = await invokeEdgeFunction<{ results?: NormalizedJamendoTrack[] }>(
    "jamendo-search", { body: { mode: "search", query } },
  );
  return (data?.results ?? []).map(toGroicTrack);
}

export async function trendingJamendo(tags?: string): Promise<GroicTrack[]> {
  const data = await invokeEdgeFunction<{ results?: NormalizedJamendoTrack[] }>(
    "jamendo-search", { body: { mode: "trending", tags } },
  );
  return (data?.results ?? []).map(toGroicTrack);
}

/** Never throws; null means "skip / mark unavailable" (same contract as the other providers). */
export async function resolveJamendoStreamUrl(providerTrackId: string): Promise<string | null> {
  try {
    const data = await invokeEdgeFunction<{ streamUrl?: string | null }>(
      "jamendo-search", { body: { mode: "stream", trackId: providerTrackId }, timeoutMs: 8000, retry: false },
    );
    return data?.streamUrl ?? null;
  } catch {
    return null;
  }
}

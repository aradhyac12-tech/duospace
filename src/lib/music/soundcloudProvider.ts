/**
 * SoundCloud provider adapter — the PRIMARY music provider. Like Audius,
 * SoundCloud resolves to a real, directly-playable stream URL, so it's
 * also natively streamable (see isNativelyStreamable() in ./types.ts).
 *
 * Unlike Audius, SoundCloud has no public self-serve API — this goes
 * through soundcloud-search, which scrapes the same client_id
 * soundcloud.com's own web player uses (see that function's header for
 * the full rationale and its known fragility). All calls are proxied
 * through the edge function; the client never talks to SoundCloud
 * directly.
 */
import { invokeEdgeFunction } from "@/lib/edgeFunction";
import { GroicTrack, makeTrackId } from "./types";

interface NormalizedSoundCloudTrack {
  provider: "soundcloud";
  providerTrackId: string;
  title: string;
  artist: string;
  artwork: string | null;
  duration: number;
  permalink: string | null;
  isStreamable: boolean;
}

const toGroicTrack = (t: NormalizedSoundCloudTrack): GroicTrack => ({
  id: makeTrackId("soundcloud", t.providerTrackId),
  provider: "soundcloud",
  providerTrackId: t.providerTrackId,
  videoId: t.providerTrackId, // see types.ts's GroicTrack.videoId doc comment
  title: t.title,
  artist: t.artist,
  thumbnail: t.artwork,
  artwork: t.artwork ?? undefined,
  duration: t.duration,
  permalink: t.permalink ?? undefined,
  isStreamable: t.isStreamable,
  isDownloadable: false, // SoundCloud tracks are never offline-downloadable — see offlineDownloads.ts's canDownload(), intentionally audius-only
});

export async function searchSoundCloud(query: string): Promise<GroicTrack[]> {
  const data = await invokeEdgeFunction<{ results?: NormalizedSoundCloudTrack[] }>(
    "soundcloud-search", { body: { mode: "search", query } },
  );
  return (data?.results ?? []).map(toGroicTrack);
}

/**
 * Resolves a track to a playable stream URL. Never throws — a failure
 * (track taken down, resolver unreachable) returns null so callers treat
 * it as "skip/mark unavailable", matching resolveAudiusStreamUrl's
 * contract exactly (see that function's doc comment in audiusProvider.ts).
 */
export async function resolveSoundCloudStreamUrl(providerTrackId: string): Promise<string | null> {
  try {
    const data = await invokeEdgeFunction<{ streamUrl?: string | null; error?: string }>(
      "soundcloud-search", { body: { mode: "stream", trackId: providerTrackId } },
    );
    return data?.streamUrl ?? null;
  } catch {
    return null;
  }
}

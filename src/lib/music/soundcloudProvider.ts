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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Statuses where a second attempt can't help (dead track, auth, throttled). */
const isFinalStatus = (status?: number) => status === 400 || status === 401 || status === 403 || status === 404 || status === 429;

/**
 * Resolves a track to a playable stream URL. Never throws — a failure
 * (track taken down, resolver unreachable) returns null so callers treat
 * it as "skip/mark unavailable", matching resolveAudiusStreamUrl's
 * contract exactly (see that function's doc comment in audiusProvider.ts).
 *
 * SPEED FIX: this used to inherit invokeEdgeFunction's 15s timeout + a
 * blind retry, so one hung request meant ~30s of "loading" after tapping play.
 * Now: an 8s ceiling per attempt, and exactly one quick retry — only for
 * transient failures (timeout / network / 5xx), never for a dead track.
 */
export async function resolveSoundCloudStreamUrl(providerTrackId: string, opts?: { fresh?: boolean }): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const data = await invokeEdgeFunction<{ streamUrl?: string | null; error?: string }>(
        "soundcloud-search",
        { body: { mode: "stream", trackId: providerTrackId, ...(opts?.fresh || attempt > 0 ? { fresh: true } : {}) }, timeoutMs: 8000, retry: false },
      );
      return data?.streamUrl ?? null;
    } catch (e) {
      if (isFinalStatus((e as { status?: number })?.status)) return null;
      if (attempt === 0) await sleep(250);
    }
  }
  return null;
}

/**
 * Resolves several tracks in ONE request (prefetching the next/previous few
 * songs). Costs one rate-limit unit instead of one per track and resolves in
 * parallel server-side. Never throws: a failed batch returns {} and callers
 * fall back to per-track resolution; a dead track maps to null.
 */
export async function resolveSoundCloudStreamUrls(providerTrackIds: string[]): Promise<Record<string, string | null>> {
  const ids = [...new Set(providerTrackIds)].slice(0, 6);
  if (ids.length === 0) return {};
  try {
    const data = await invokeEdgeFunction<{ streams?: Record<string, string | null> }>(
      "soundcloud-search", { body: { mode: "streams", trackIds: ids }, timeoutMs: 7000, retry: false },
    );
    return data?.streams ?? {};
  } catch {
    return {};
  }
}

/**
 * YouTube provider adapter. Deliberately thin — YouTube's actual
 * search/trending fetching still lives in supabase/functions/music-search
 * and music-trending exactly as before this refactor (untouched); this
 * file only normalizes their existing response shape into the shared
 * GroicTrack model so the rest of the app (queue, search UI, shared
 * listening) never needs a YouTube-specific code path to read a track.
 *
 * IMPORTANT: a youtube-provider GroicTrack never has `isStreamable: true`
 * for the native engine's purposes — see isNativelyStreamable() in
 * ./types.ts. YouTube tracks always play through the existing hidden
 * IFrame player in GroicContext, never through the native background
 * engine, and this app does not extract or proxy YouTube's actual audio
 * — see docs/MUSIC_NATIVE_PLAYBACK.md.
 */
import { GroicTrack, makeTrackId } from "./types";

export interface YouTubeSearchResult {
  title: string;
  artist: string;
  videoId: string;
  thumbnail: string;
  duration: number;
  url: string;
}

export const youtubeResultToTrack = (r: YouTubeSearchResult): GroicTrack => ({
  id: makeTrackId("youtube", r.videoId),
  provider: "youtube",
  providerTrackId: r.videoId,
  videoId: r.videoId,
  title: r.title,
  artist: r.artist,
  thumbnail: r.thumbnail,
  artwork: r.thumbnail,
  duration: r.duration,
  isStreamable: false, // not natively streamable — see file header
});

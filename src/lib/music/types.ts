/**
 * Provider-agnostic music model.
 *
 * Adapted from GroicContext's original `GroicTrack` (which was YouTube-only
 * — `videoId` as the primary key, no notion of a provider at all) into a
 * shape any provider adapter can produce and the player/UI never needs to
 * branch on. `videoId` is kept (not renamed) because it's referenced well
 * beyond GroicContext — chat's shared-song messages, Playlist.tsx's saved
 * songs table, GroicFullPlayer's queue rendering — and this pass is a
 * provider-abstraction refactor, not a field-renaming exercise. For a
 * non-YouTube track, `videoId` just holds the same value as
 * `providerTrackId` so every existing `x.videoId` read in the codebase
 * keeps working unchanged.
 */

/** Every source a track can come from. `local` is reserved for a possible
 *  future "device file" provider — not implemented, kept so the type
 *  doesn't need another breaking change if that's ever added. */
export type MusicProvider = "youtube" | "audius" | "soundcloud" | "local";

export interface GroicTrack {
  /** Stable id for React keys / queue membership. Always
   *  `${provider}:${providerTrackId}` — unique across providers, unlike
   *  providerTrackId alone (an Audius track id and a YouTube video id are
   *  drawn from different id spaces and could theoretically collide). */
  id: string;
  provider: MusicProvider;
  /** The id in the provider's own namespace — a YouTube video id, an
   *  Audius track id, etc. */
  providerTrackId: string;
  /** BACK-COMPAT: mirrors providerTrackId for youtube-provider tracks (the
   *  only kind that existed before this refactor). Every pre-existing
   *  `track.videoId` read in the app (chat share-song, Playlist.tsx,
   *  GroicFullPlayer's queue list) keeps working without being touched.
   *  For non-YouTube tracks this is set to the same value as
   *  providerTrackId too, so `videoId` is really just "this provider's
   *  track id" under its original name — never empty/undefined. */
  videoId: string;
  title: string;
  artist: string;
  album?: string;
  /** BACK-COMPAT alias of `artwork` — GroicMiniPlayer/GroicFullPlayer and
   *  every pre-existing call site read `thumbnail`, not `artwork`. Kept
   *  as the "real" field so no UI component needs to change; `artwork` is
   *  offered as an alias for code written against the shape in this
   *  session's brief. */
  thumbnail: string | null;
  /** Alias of `thumbnail` — audiusProvider/youtubeProvider adapters and
   *  nativeAudioEngine write/read this name (per an earlier phase's brief)
   *  but it was never declared on the interface, which made every adapter
   *  a compile error. Same value as `thumbnail`; UI keeps reading
   *  `thumbnail`. */
  artwork?: string | null;
  duration: number;
  /** Only meaningful for provider adapters that resolve a direct,
   *  playable stream URL server-side (Audius). YouTube tracks never set
   *  this — the whole point of keeping YouTube on the IFrame player is
   *  that DuoSpace never touches a raw YouTube audio URL at all. */
  streamUrl?: string;
  /** Audius's public track permalink (e.g. for "open in Audius" or
   *  crediting the artist), not used for playback. */
  permalink?: string;
  /** False for a track a provider has marked as not streamable (a
   *  region-locked or delisted Audius track, for instance) — the UI
   *  should show it as unavailable rather than let it be queued. */
  isStreamable?: boolean;
  isDownloadable?: boolean;
}

export type RepeatMode = "off" | "one" | "all";

/** True for a provider whose tracks the native background engine can
 *  actually play (a direct, resolvable audio stream). YouTube is
 *  deliberately excluded — see native-plugins/audio-engine's README and
 *  docs/MUSIC_NATIVE_PLAYBACK.md for why YouTube audio is never routed
 *  through the native engine or extracted from the IFrame. SoundCloud
 *  joins Audius here — soundcloud-search resolves a real, directly
 *  playable stream URL the same way audius-search does, just via an
 *  unofficial (scraped client_id) path instead of a public API — see
 *  soundcloud-search/index.ts's header for the full rationale. */
export const isNativelyStreamable = (t: Pick<GroicTrack, "provider" | "isStreamable">): boolean =>
  (t.provider === "audius" || t.provider === "soundcloud") && t.isStreamable !== false;

export const makeTrackId = (provider: MusicProvider, providerTrackId: string): string =>
  `${provider}:${providerTrackId}`;

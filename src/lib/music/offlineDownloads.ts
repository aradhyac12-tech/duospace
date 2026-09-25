/**
 * Offline downloads for Audius tracks.
 *
 * Scope, deliberately narrow per the Phase 4 Music brief:
 *  - YouTube is never downloadable here. There is no code path in this
 *    file that touches a YouTube URL at all — see resolveAudiusStreamUrl
 *    being the only stream-URL source a download can start from.
 *  - An Audius track is only offered for download when the provider
 *    itself marked it `isDownloadable` (see audiusProvider.ts /
 *    audius-search's normalization) — never inferred, never assumed true.
 *  - Native platforms only. The web build (including iOS Safari) has no
 *    app-private persistent filesystem to write into — Capacitor's
 *    Filesystem plugin only backs onto a real filesystem on Android/iOS.
 *    `isOfflineDownloadSupported()` is the single check every caller
 *    (UI and this module) uses, so "offline playback isn't available"
 *    is shown honestly instead of a downloaded file silently vanishing
 *    on the next page load.
 *
 * Storage split, matching the existing codebase's own conventions:
 *  - Audio bytes → @capacitor/filesystem, Directory.Data (app-private,
 *    survives app restarts, not visible to the user's Files/Photos app —
 *    same directory class already used for durable app data elsewhere).
 *  - The lightweight index (which tracks are downloaded, their local
 *    URI, title/artist/artwork for the Downloads list) → `storage`
 *    (src/lib/storage.ts), this codebase's existing small-JSON wrapper,
 *    rather than inventing a second persistence mechanism for what's a
 *    few KB of metadata.
 */
import { Capacitor } from "@capacitor/core";
import storage from "@/lib/storage";
import { GroicTrack } from "./types";
import { resolveAudiusStreamUrl } from "./audiusProvider";

const INDEX_KEY = "groic-offline-downloads-index";
const DOWNLOAD_SUBDIR = "music-downloads";

export interface DownloadedTrack {
  id: string; // GroicTrack.id — `${provider}:${providerTrackId}`
  providerTrackId: string;
  title: string;
  artist: string;
  thumbnail: string | null; // kept as the original remote URL — see known limitation below
  duration: number;
  fileName: string;
  downloadedAt: number;
}

export type DownloadProgressListener = (fractionComplete: number | null) => void;

/** Single source of truth for whether offline download/playback can work
 *  at all on this platform. Every UI call site (Download button visibility,
 *  Downloads screen) should gate on this, not re-derive it. */
export function isOfflineDownloadSupported(): boolean {
  return Capacitor.isNativePlatform();
}

function readIndex(): DownloadedTrack[] {
  return storage.getJSON<DownloadedTrack[]>(INDEX_KEY, []);
}

function writeIndex(list: DownloadedTrack[]): void {
  storage.setJSON(INDEX_KEY, list);
}

export function listDownloads(): DownloadedTrack[] {
  return readIndex();
}

export function getDownloadedTrack(trackId: string): DownloadedTrack | null {
  return readIndex().find((d) => d.id === trackId) ?? null;
}

export function isDownloaded(trackId: string): boolean {
  return getDownloadedTrack(trackId) != null;
}

/** True only when this specific track is actually eligible — provider
 *  metadata said so AND the platform can store it. Never true for a
 *  YouTube track (provider !== "audius" fails immediately). */
export function canDownload(track: Pick<GroicTrack, "provider" | "isDownloadable">): boolean {
  return isOfflineDownloadSupported() && track.provider === "audius" && track.isDownloadable === true;
}

/** Best-effort guess at a file extension from the resolved stream's
 *  Content-Type. Audius streams are MP3 in practice, but this is derived
 *  from the real response rather than hard-assumed, so a differently
 *  encoded stream still gets a technically-correct extension. */
function extensionFromContentType(contentType: string | null): string {
  if (!contentType) return "mp3";
  if (contentType.includes("mpeg") || contentType.includes("mp3")) return "mp3";
  if (contentType.includes("mp4") || contentType.includes("aac") || contentType.includes("m4a")) return "m4a";
  if (contentType.includes("ogg")) return "ogg";
  if (contentType.includes("wav")) return "wav";
  return "mp3";
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000; // avoid a giant single call to String.fromCharCode for large files
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Downloads a track's audio into app-private storage and records it in
 * the local index. Rejects (never silently no-ops) if the track isn't a
 * downloadable Audius track or the platform can't support it — callers
 * should have already hidden the Download affordance per canDownload(),
 * so reaching this rejection means something changed between render and
 * tap, not a normal path.
 *
 * Progress is reported as a 0–1 fraction when the response provides a
 * Content-Length header, or `null` (indeterminate) when it doesn't —
 * Audius doesn't guarantee that header on every stream, and this is
 * surfaced honestly rather than faking a smooth progress bar.
 */
export async function downloadTrack(
  track: GroicTrack,
  onProgress?: DownloadProgressListener,
): Promise<DownloadedTrack> {
  if (!canDownload(track)) {
    throw new Error(
      track.provider !== "audius"
        ? "Offline playback isn't available for this track."
        : !isOfflineDownloadSupported()
        ? "Offline downloads require the DuoSpace app, not the web version."
        : "Offline playback isn't available for this track.",
    );
  }

  const existing = getDownloadedTrack(track.id);
  if (existing) return existing;

  const streamUrl = track.streamUrl ?? (await resolveAudiusStreamUrl(track.providerTrackId));
  if (!streamUrl) {
    throw new Error("Offline playback isn't available for this track.");
  }

  const response = await fetch(streamUrl);
  if (!response.ok || !response.body) {
    throw new Error("Couldn't download this track right now.");
  }

  const contentLength = Number(response.headers.get("content-length") ?? "0") || null;
  const contentType = response.headers.get("content-type");
  const ext = extensionFromContentType(contentType);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.byteLength;
      onProgress?.(contentLength ? Math.min(received / contentLength, 1) : null);
    }
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const base64 = arrayBufferToBase64(merged.buffer);

  const fileName = `${track.provider}_${track.providerTrackId}.${ext}`;
  const path = `${DOWNLOAD_SUBDIR}/${fileName}`;

  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  // mkdir is best-effort — Filesystem throws if the directory already
  // exists, which is the expected case after the first download.
  try {
    await Filesystem.mkdir({ path: DOWNLOAD_SUBDIR, directory: Directory.Data, recursive: true });
  } catch {
    // already exists — fine
  }
  await Filesystem.writeFile({ path, data: base64, directory: Directory.Data });

  const entry: DownloadedTrack = {
    id: track.id,
    providerTrackId: track.providerTrackId,
    title: track.title,
    artist: track.artist,
    thumbnail: track.thumbnail,
    duration: track.duration,
    fileName,
    downloadedAt: Date.now(),
  };
  writeIndex([entry, ...readIndex().filter((d) => d.id !== track.id)]);
  onProgress?.(1);
  return entry;
}

export async function removeDownload(trackId: string): Promise<void> {
  const entry = getDownloadedTrack(trackId);
  writeIndex(readIndex().filter((d) => d.id !== trackId));
  if (!entry) return;
  try {
    const { Filesystem, Directory } = await import("@capacitor/filesystem");
    await Filesystem.deleteFile({ path: `${DOWNLOAD_SUBDIR}/${entry.fileName}`, directory: Directory.Data });
  } catch {
    // File already gone (manually cleared app storage, etc.) — the index
    // entry is already removed above, which is the state that matters.
  }
}

/**
 * Resolves a downloaded track back into a playable GroicTrack whose
 * `streamUrl` points at the local file, for handing to the native audio
 * engine exactly like any other Audius track (see nativeAudioEngine.ts —
 * it doesn't care whether streamUrl is a remote Audius URL or a local
 * file:// URI, both are just "the URL to play").
 */
export async function getOfflinePlayableTrack(trackId: string): Promise<GroicTrack | null> {
  const entry = getDownloadedTrack(trackId);
  if (!entry) return null;
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  try {
    const { uri } = await Filesystem.getUri({ path: `${DOWNLOAD_SUBDIR}/${entry.fileName}`, directory: Directory.Data });
    return {
      id: entry.id,
      provider: "audius",
      providerTrackId: entry.providerTrackId,
      videoId: entry.providerTrackId,
      title: entry.title,
      artist: entry.artist,
      thumbnail: entry.thumbnail,
      duration: entry.duration,
      streamUrl: uri,
      isStreamable: true,
      isDownloadable: true,
    };
  } catch {
    // The file the index points to is gone (storage cleared out from
    // under the app). Drop the now-stale index entry rather than leaving
    // a "downloaded" track that can't actually play.
    writeIndex(readIndex().filter((d) => d.id !== trackId));
    return null;
  }
}

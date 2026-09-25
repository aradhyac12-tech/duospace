/**
 * peekSnapshot — local-only photo evidence for Peek Guard breach events.
 *
 * Deliberately separate from faceRecognition.ts's owner embeddings: those
 * never store an actual photo (a mathematical template only — the same
 * design choice Face ID itself makes, see faceRecognition.ts's own header
 * comment). This module exists for the opposite, human-facing purpose —
 * when a breach locks the screen, capture one small JPEG frame so the owner
 * can later SEE what tripped the alarm (a face, an empty room, a hand over
 * the lens), the way a doorbell camera clip works. Never uploaded, never
 * synced, capped and pruned the same way peekEventLog.ts's own history is.
 *
 * Stored in the same "duo-assets"/"blobs" IndexedDB store as owner
 * embeddings and app icon assets, keyed `peek-snapshot-{eventId}` so it can
 * be looked up directly from a PeekEvent.id (see peekEventLog.ts).
 */
import { idbGet, idbSet, idbDelete, idbKeys } from "@/lib/idbStore";

const KEY_PREFIX = "peek-snapshot-";
// Photos are far heavier than the plain-JSON event log entries they're
// attached to, so kept to a much smaller rolling window than
// peekEventLog's own MAX_EVENTS (200) — this is "the last few pieces of
// evidence", not a full history.
const MAX_SNAPSHOTS = 20;
// Small evidence thumbnail, not a full-res photo — keeps IndexedDB usage
// light and capture itself near-instant.
const MAX_DIMENSION = 240;
const JPEG_QUALITY = 0.6;

/**
 * Downsizes + encodes the current video frame to a small JPEG data URL and
 * stores it against a peek event id. Best-effort by design: a capture
 * failure (camera torn down mid-lock, video not ready yet) must never throw
 * into the detection loop that calls this — it just means that one event
 * ends up with no photo, which the UI already handles (see
 * SecurityDashboard.tsx).
 */
export const capturePeekSnapshot = async (
  video: HTMLVideoElement,
  eventId: string,
): Promise<void> => {
  try {
    if (!video.videoWidth || !video.videoHeight) return;
    const scale = Math.min(1, MAX_DIMENSION / Math.max(video.videoWidth, video.videoHeight));
    const w = Math.max(1, Math.round(video.videoWidth * scale));
    const h = Math.max(1, Math.round(video.videoHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, w, h);
    const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    await idbSet(KEY_PREFIX + eventId, dataUrl);
    await pruneOldSnapshots();
  } catch {
    /* evidence photo only — never fatal to the lock itself */
  }
};

export const getPeekSnapshot = (eventId: string): Promise<string | null> =>
  idbGet(KEY_PREFIX + eventId);

export const deletePeekSnapshot = (eventId: string): Promise<void> =>
  idbDelete(KEY_PREFIX + eventId);

export const clearAllPeekSnapshots = async (): Promise<void> => {
  const keys = await idbKeys();
  await Promise.all(keys.filter((k) => k.startsWith(KEY_PREFIX)).map((k) => idbDelete(k)));
};

/**
 * Keeps only the most recent MAX_SNAPSHOTS. Event ids are
 * `${Date.now()}-${rand}` (see peekEventLog.ts's logPeekEvent) — the
 * leading epoch-ms timestamp is a fixed 13 digits for the foreseeable
 * future, so a plain lexical sort on the id already sorts oldest→newest.
 */
const pruneOldSnapshots = async (): Promise<void> => {
  const keys = (await idbKeys()).filter((k) => k.startsWith(KEY_PREFIX));
  if (keys.length <= MAX_SNAPSHOTS) return;
  const sorted = [...keys].sort((a, b) => a.localeCompare(b));
  const toDelete = sorted.slice(0, sorted.length - MAX_SNAPSHOTS);
  await Promise.all(toDelete.map((k) => idbDelete(k)));
};

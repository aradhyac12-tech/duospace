// Vanish Mode ⇄ media helpers.
//
// Two jobs, both about making sure a photo / video / file / voice note shared
// during Vanish Mode really disappears from THIS device too — not just from
// the server:
//   1. keep it out of the on-device media cache in the first place
//      (markVanishMedia — called before its URL is resolved);
//   2. wipe any local trace when the message is deleted (forgetVanishMedia).
import { extractStoragePath, forgetSignedUrl } from "@/lib/signedStorageUrl";
import { markMediaEphemeral, deleteLocalMedia } from "@/lib/mediaCache";
import { isVanishValue } from "@/lib/chatConstants";

export const CHAT_BUCKET = "chat-files";

/** Storage path (`<uploader-id>/<file>`) of a chat-files URL, or null. */
export function chatFilePath(fileUrl: string | null | undefined): string | null {
  if (!fileUrl) return null;
  return extractStoragePath(CHAT_BUCKET, fileUrl);
}

/**
 * The object's real name in storage. file_url comes from getPublicUrl(), which
 * percent-encodes the path ("my photo.jpg" → "my%20photo.jpg"), but
 * storage.remove() wants the decoded name. (chatFilePath above stays encoded
 * on purpose — that's the key the on-device cache and signed-URL cache use.)
 */
export function chatFileObjectName(fileUrl: string | null | undefined): string | null {
  const path = chatFilePath(fileUrl);
  if (!path) return null;
  try { return decodeURIComponent(path); } catch { return path; }
}

/**
 * Call for every message BEFORE resolving its media URL. If it's a vanish
 * message with a file, the file is registered as "never cache this".
 */
export function markVanishMedia(msg: { file_url?: string | null; disappear_at?: string | null }): void {
  if (!msg.file_url || !isVanishValue(msg.disappear_at)) return;
  const path = chatFilePath(msg.file_url);
  if (path) markMediaEphemeral(CHAT_BUCKET, path);
}

/** Same, for a path that's already known (the upload just finished). */
export function markVanishMediaPath(fileUrl: string | null | undefined): void {
  const path = chatFilePath(fileUrl);
  if (path) markMediaEphemeral(CHAT_BUCKET, path);
}

/** Remove every local trace of one deleted vanish file. Never throws. */
export async function forgetVanishMedia(fileUrlOrPath: string | null | undefined): Promise<void> {
  if (!fileUrlOrPath) return;
  // Accepts either a raw file_url or an already-extracted storage path.
  const path = chatFilePath(fileUrlOrPath) ?? (fileUrlOrPath.includes("://") ? null : fileUrlOrPath);
  if (!path) return;
  markMediaEphemeral(CHAT_BUCKET, path);
  forgetSignedUrl(CHAT_BUCKET, path);
  await deleteLocalMedia(CHAT_BUCKET, path);
}

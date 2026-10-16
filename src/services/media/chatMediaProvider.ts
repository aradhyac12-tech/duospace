// Chat's provider boundary. Chat.tsx calls uploadChatMedia() and never learns which
// storage took the bytes. Flag OFF (default) => the legacy Supabase path, byte-for-byte
// the behaviour Chat had before. Flag ON => Cloudinary for photos/videos, with:
//   - disappearing/vanish messages kept on the legacy path (their purge/forget machinery
//     only knows Supabase Storage objects),
//   - voice notes and generic files kept on the legacy path,
//   - a fallback to legacy ONLY if signing is unavailable (nothing was uploaded yet).
import { CLOUDINARY_CHAT_MEDIA_ENABLED } from "./config";
import { uploadToCloudinary } from "./cloudinary";
import { uploadLegacyChatFile } from "./legacySupabaseMedia";
import { MediaError, type UploadState } from "./types";
import { logWarn } from "@/lib/telemetry";

export interface ChatUploadInput {
  userId: string; clientId: string; msgType: string; fileName: string;
  file: Blob; contentType?: string; disappearAt: unknown;
  onProgress?: (uploaded: number, total: number) => void;
  onState?: (s: UploadState) => void;
  signal?: AbortSignal;
}
export interface ChatUploadResult { pseudoPublicUrl: string; path: string; mediaAssetId?: string }

export const shouldUseCloudinaryForChat = (msgType: string, disappearAt: unknown, enabled = CLOUDINARY_CHAT_MEDIA_ENABLED) =>
  enabled && !disappearAt && (msgType === "image" || msgType === "video");

export async function uploadChatMedia(i: ChatUploadInput, enabled = CLOUDINARY_CHAT_MEDIA_ENABLED): Promise<ChatUploadResult> {
  const legacy = () => uploadLegacyChatFile({
    objectPath: `${i.userId}/${i.clientId.replace(/^pending-/, "")}_${i.fileName}`,
    file: i.file, contentType: i.contentType, onProgress: i.onProgress,
  });
  if (!shouldUseCloudinaryForChat(i.msgType, i.disappearAt, enabled)) return legacy();
  try {
    const r = await uploadToCloudinary(i.file, {
      scope: "chat", filename: i.fileName, signal: i.signal, onState: i.onState, onProgress: i.onProgress,
      // Stable per message => a retried send re-signs the SAME public_id (no duplicate asset).
      clientUploadId: i.clientId.replace(/^pending-/, ""),
    });
    return { pseudoPublicUrl: r.ref, path: r.ref, mediaAssetId: r.mediaId };
  } catch (e) {
    if (e instanceof MediaError && e.code === "NOT_CONFIGURED") {
      logWarn("chat.send", "Cloudinary not configured — using legacy upload");
      return legacy();
    }
    throw e;
  }
}

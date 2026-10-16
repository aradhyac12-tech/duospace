// Legacy provider: media that still lives in Supabase Storage (chat-files / gallery /
// memories / avatars) and is referenced by plain URL strings. Nothing here changes how
// legacy media works — it just exposes it behind the same abstraction.
import { resolveSignedUrl } from "@/lib/signedStorageUrl";
import { directUpload } from "@/lib/directUpload";
import { resumableUpload } from "@/lib/resumableUpload";
import { logWarn } from "@/lib/telemetry";

export const resolveLegacyMediaUrl = (bucket: string, rawUrl: string) => resolveSignedUrl(bucket, rawUrl);

const DIRECT_MAX_BYTES = 100 * 1024 * 1024;

/** The exact upload strategy Chat has always used: one direct request, chunked resumable fallback. */
export async function uploadLegacyChatFile(opts: {
  objectPath: string; file: Blob; contentType?: string; onProgress?: (u: number, t: number) => void;
}): Promise<{ pseudoPublicUrl: string; path: string }> {
  const { objectPath, file, contentType, onProgress } = opts;
  try {
    if (file.size > DIRECT_MAX_BYTES) throw new Error("too large for direct path");
    return await directUpload({ bucket: "chat-files", objectPath, file, contentType, onProgress });
  } catch (directErr) {
    logWarn("chat.send", "direct upload failed — falling back to chunked", { error: String(directErr) });
    return await resumableUpload({ bucket: "chat-files", objectPath, file, contentType, onProgress });
  }
}

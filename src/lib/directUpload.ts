/**
 * Fast single-request upload with real byte-level progress.
 *
 * WHY: resumableUpload's chunk → list → verify → finalize-upload edge
 * function pipeline costs several extra round-trips per file, and the edge
 * function then downloads every chunk and re-uploads the merged object —
 * for a 20 MB video that roughly doubles total transfer time. For files
 * inside the bucket's own size limit, one direct PUT to Storage (the same
 * owner-folder INSERT policy the WhatsApp importer and Gallery already rely
 * on) is dramatically faster, and XHR gives true upload progress, which
 * supabase-js's storage.upload() does not.
 *
 * Callers fall back to resumableUpload if this throws, so a flaky network
 * still gets chunked retry/resume.
 */
import { supabase } from "@/integrations/supabase/appClient";
import { SUPABASE_URL_PUBLIC, SUPABASE_KEY_PUBLIC } from "@/integrations/supabase/client";

export interface DirectUploadResult { pseudoPublicUrl: string; path: string }

export async function directUpload(opts: {
  bucket: string;
  objectPath: string;
  file: Blob;
  contentType?: string;
  onProgress?: (uploaded: number, total: number) => void;
  signal?: AbortSignal;
}): Promise<DirectUploadResult> {
  const { bucket, objectPath, file, onProgress, signal } = opts;
  const contentType = opts.contentType || (file as File).type || "application/octet-stream";
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Must be signed in to upload");

  const encodedPath = objectPath.split("/").map(encodeURIComponent).join("/");
  const url = `${SUPABASE_URL_PUBLIC}/storage/v1/object/${bucket}/${encodedPath}`;

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("Authorization", `Bearer ${session.access_token}`);
    xhr.setRequestHeader("apikey", SUPABASE_KEY_PUBLIC);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.setRequestHeader("x-upsert", "true");
    xhr.setRequestHeader("cache-control", "max-age=3600");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded, e.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Direct upload failed (${xhr.status}): ${xhr.responseText?.slice(0, 200)}`));
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.ontimeout = () => reject(new Error("Upload timed out"));
    if (signal) signal.addEventListener("abort", () => { xhr.abort(); reject(new Error("Upload aborted")); }, { once: true });
    onProgress?.(0, file.size);
    xhr.send(file);
  });

  onProgress?.(file.size, file.size);
  const { data } = supabase.storage.from(bucket).getPublicUrl(objectPath);
  return { pseudoPublicUrl: data.publicUrl, path: objectPath };
}

/** Downscale large photos before sending (WhatsApp-style). GIFs and
 *  already-small images pass through untouched. Never throws — on any
 *  decode problem the original file is returned.
 *
 *  NOT CALLED from Chat.tsx anymore (photos now send at raw/original
 *  quality — see attemptSendMedia's comment). Left in place rather than
 *  deleted per this project's "don't delete without dependency analysis"
 *  convention (.ai/DO_NOT_CHANGE.md) — nothing else currently imports it. */
export async function compressImageForSend(file: Blob, maxDim = 2048, quality = 0.82): Promise<Blob> {
  try {
    const type = file.type || "";
    if (!type.startsWith("image/") || type === "image/gif" || type === "image/svg+xml") return file;
    if (file.size < 600 * 1024) return file;
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const out: Blob | null = await new Promise((r) => canvas.toBlob(r, "image/jpeg", quality));
    if (!out || out.size >= file.size) return file;
    const name = ((file as File).name || "photo").replace(/\.[^.]+$/, "") + ".jpg";
    return new File([out], name, { type: "image/jpeg" });
  } catch {
    return file;
  }
}

/**
 * Resumable chunked upload client.
 *
 * Splits a File into N chunks and uploads each chunk to a sibling path in the
 * given Supabase Storage bucket. On a flaky network each chunk is retried
 * independently with exponential backoff; previously-uploaded chunks are
 * skipped on resume by checking the bucket listing.
 *
 * Once all chunks are present, an edge function (`finalize-upload`) reassembles
 * them into the final object and clears the pending_uploads row.
 *
 * If the user abandons the upload, a periodic cron clears anything older than
 * 24h via `cleanup-orphan-uploads`.
 */
import { supabase } from "@/integrations/supabase/client";
import { withRetry } from "@/lib/networkState";
import { logError, logInfo } from "@/lib/telemetry";
import { invokeEdgeFunction } from "@/lib/edgeFunction";

const DEFAULT_CHUNK_SIZE = 1024 * 1024; // 1 MB

// PHASE 8F FIX (Final Release Audit): storage RLS on every bucket this is
// used against (chat-files, gallery, memories) requires
// (storage.foldername(name))[1] = auth.uid()::text — the object's FIRST
// path segment must be the caller's own user id. objectPath is always
// `${userId}/...` (per the ResumableUploadOptions doc comment below), but
// the original chunk scheme put chunks at `.tmp/${objectPath}.part-N`,
// making `.tmp` the first segment instead of the user id. That fails BOTH
// the INSERT policy (chunk upload) and the SELECT policy (the resume-scan
// .list() call) under RLS as the authenticated client — chunks could never
// actually be uploaded by this implementation, which is very likely why it
// was written but never wired into Gallery.tsx. Fixed by nesting `.tmp`
// *inside* the user's own folder instead of putting it first.
function splitOwnerFolder(objectPath: string): { owner: string; rest: string } {
  const idx = objectPath.indexOf("/");
  if (idx === -1) return { owner: objectPath, rest: "" };
  return { owner: objectPath.slice(0, idx), rest: objectPath.slice(idx + 1) };
}

function chunkDir(objectPath: string): string {
  const { owner, rest } = splitOwnerFolder(objectPath);
  const restDir = rest.includes("/") ? rest.slice(0, rest.lastIndexOf("/")) : "";
  return restDir ? `${owner}/.tmp/${restDir}` : `${owner}/.tmp`;
}

export interface ResumableUploadOptions {
  bucket: string;
  /** Path of the final assembled object, e.g. `${userId}/${uuid}.jpg` */
  objectPath: string;
  file: File | Blob;
  chunkSize?: number;
  contentType?: string;
  onProgress?: (uploaded: number, total: number) => void;
  signal?: AbortSignal;
}

export interface ResumableUploadResult {
  /**
   * PHASE 8.5 (Storage Contract Cleanup): this is the output of Supabase's
   * `getPublicUrl()`, which just string-templates
   * "/object/public/<bucket>/<path>" — it does NOT check whether the
   * bucket is actually public and does not fail if it isn't. Every bucket
   * this is used against (gallery, chat-files, memories) is PRIVATE, so
   * this URL is not actually fetchable as-is. It is named `pseudoPublicUrl`
   * (not `publicUrl`) to stop that from reading as a working link.
   *
   * It is kept, unchanged in value, because the rest of the app already
   * has an established convention of storing exactly this getPublicUrl()-
   * shaped string in DB columns like gallery_items.file_url, and resolving
   * it back to a real, loadable URL at render time via
   * src/lib/signedStorageUrl.ts (which parses the object path back out of
   * this string via the "/<bucket>/" marker and mints a fresh signed URL).
   * Renaming this field to something implying it's directly usable (or
   * changing what it stores to a bare path) would require also changing
   * that storage convention and every consumer of it — out of scope for a
   * naming cleanup. Callers that persist this value MUST resolve it
   * through resolveSignedUrl()/resolveSignedUrls() before rendering it,
   * exactly as the existing single-shot upload path already does.
   */
  pseudoPublicUrl: string;
  /** Bare storage object path, e.g. `${userId}/${uuid}.jpg` — safe to use directly with signed-URL helpers without any marker-parsing. */
  path: string;
}

function chunkPathFor(objectPath: string, index: number) {
  const fileName = objectPath.slice(objectPath.lastIndexOf("/") + 1);
  return `${chunkDir(objectPath)}/${fileName}.part-${index.toString().padStart(5, "0")}`;
}

export async function resumableUpload(opts: ResumableUploadOptions): Promise<ResumableUploadResult> {
  const {
    bucket,
    objectPath,
    file,
    chunkSize = DEFAULT_CHUNK_SIZE,
    contentType = (file as File).type || "application/octet-stream",
    onProgress,
    signal,
  } = opts;

  const totalSize = file.size;
  const totalChunks = Math.max(1, Math.ceil(totalSize / chunkSize));

  // Track this upload so the cleanup job can collect orphans
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Must be signed in to upload");

  const { error: trackErr } = await supabase.from("pending_uploads").upsert({
    user_id: user.id,
    bucket,
    object_path: objectPath,
    total_chunks: totalChunks,
    total_bytes: totalSize,
    content_type: contentType,
  }, { onConflict: "user_id,bucket,object_path" });
  if (trackErr) logError("resumable", "track row failed", trackErr);

  // Discover already-uploaded chunks (resume support)
  const { data: existing } = await supabase.storage
    .from(bucket)
    .list(chunkDir(objectPath), { limit: 1000 });
  const uploadedSet = new Set((existing ?? []).map((e) => e.name));

  let uploadedBytes = 0;

  for (let i = 0; i < totalChunks; i++) {
    if (signal?.aborted) throw new Error("Upload aborted");

    const chunkPath = chunkPathFor(objectPath, i);
    const chunkName = chunkPath.split("/").pop()!;

    if (uploadedSet.has(chunkName)) {
      uploadedBytes += Math.min(chunkSize, totalSize - i * chunkSize);
      onProgress?.(uploadedBytes, totalSize);
      continue;
    }

    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, totalSize);
    const blob = file.slice(start, end);

    await withRetry(async () => {
      const { error } = await supabase.storage
        .from(bucket)
        .upload(chunkPath, blob, { upsert: true, contentType });
      if (error) throw error;
    }, { maxAttempts: 4, baseDelayMs: 800, maxDelayMs: 8000 });

    uploadedBytes += end - start;
    onProgress?.(uploadedBytes, totalSize);
  }

  // Server-side reassembly. invokeEdgeFunction already retries once on
  // transport failure only (never on a real 4xx/5xx from the function,
  // since finalize isn't safely repeatable if it partially reassembled).
  logInfo("resumable", `finalizing ${objectPath} (${totalChunks} chunks)`);
  try {
    return await invokeEdgeFunction<ResumableUploadResult>("finalize-upload", {
      body: { bucket, objectPath, totalChunks, contentType },
    });
  } catch (err) {
    logError("resumable", "finalize failed", err);
    throw err;
  }
}

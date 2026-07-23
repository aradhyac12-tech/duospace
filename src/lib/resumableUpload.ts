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
  publicUrl: string;
  path: string;
}

function chunkPathFor(objectPath: string, index: number) {
  return `.tmp/${objectPath}.part-${index.toString().padStart(5, "0")}`;
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
    .list(`.tmp/${objectPath.split("/").slice(0, -1).join("/")}`, { limit: 1000 });
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

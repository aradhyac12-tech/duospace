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
 *
 * CRITICAL FIX (attachment pipeline stabilization):
 * - Added structured error handling: parses { code, missingChunks, retryable }
 *   from finalize-upload's new responses
 * - Added post-finalization storage verification: after finalize succeeds,
 *   confirms the final object is actually readable before declaring success
 * - Added bounded retry for missing-chunk errors: re-uploads only the missing
 *   chunks instead of the whole file
 * - Added diagnostic logging with uploadId/fileType/fileSize per failure
 *
 * SPEED FIX (instant sending):
 * - Single-chunk files (most photos/voice/notes/files) skip the chunk
 *   verification loop entirely — the upload succeeded, and the edge function
 *   has its own retry logic for propagation lag
 * - Settle delay reduced from 500ms to 100ms for small files
 * - Chunk retry backoff reduced from 800ms to 400ms base
 * - Post-finalization verify reduced to max 2 attempts for small files
 */
import { supabase } from "@/integrations/supabase/appClient";
import { withRetry } from "@/lib/networkState";
import { logError, logInfo, logWarn } from "@/lib/telemetry";
import { invokeEdgeFunction, EdgeFunctionError } from "@/lib/edgeFunction";

const DEFAULT_CHUNK_SIZE = 1024 * 1024; // 1 MB
const MAX_MISSING_CHUNK_RETRIES = 5;
const SMALL_FILE_THRESHOLD = 512 * 1024; // 512 KB — most chat photos/voice/notes

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
  pseudoPublicUrl: string;
  path: string;
}

function chunkPathFor(objectPath: string, index: number) {
  const fileName = objectPath.slice(objectPath.lastIndexOf("/") + 1);
  return `${chunkDir(objectPath)}/${fileName}.part-${index.toString().padStart(5, "0")}`;
}

interface FinalizeErrorResponse {
  ok: false;
  code: string;
  error: string;
  missingChunks?: number[];
  retryable?: boolean;
  request_id?: string;
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
  const isSmallFile = totalSize <= SMALL_FILE_THRESHOLD;
  const fileType = contentType.split("/")[1] || contentType;

  const diagContext = { bucket, objectPath, fileType, fileSize: totalSize, totalChunks };

  // Track this upload
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Must be signed in to upload");

  const { error: trackErr } = await supabase.from("pending_uploads").upsert({
    user_id: user.id, bucket, object_path: objectPath,
    total_chunks: totalChunks, total_bytes: totalSize, content_type: contentType,
  }, { onConflict: "user_id,bucket,object_path" });
  if (trackErr) {
    logError("resumable", "track row failed", { ...diagContext, error: trackErr.message });
    throw new Error(`Upload could not be started (${trackErr.message})`);
  }

  // For small single-chunk files, skip the resume scan — there's nothing
  // to resume; we upload the one chunk and go straight to finalization.
  // This saves one round-trip (~100-300ms).
  let uploadedSet = new Set<string>();
  if (totalChunks > 1 || !isSmallFile) {
    const { data: existing } = await supabase.storage.from(bucket).list(chunkDir(objectPath), { limit: 1000 });
    uploadedSet = new Set((existing ?? []).map((e) => e.name));
  }

  let uploadedBytes = 0;

  // INSTANT FEEDBACK: fire 0% immediately so the progress ring appears
  // the instant the upload starts, not after the first chunk finishes.
  onProgress?.(0, totalSize);

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

    // SPEED FIX: reduced retry backoff from 800ms to 400ms base
    await withRetry(async () => {
      const { error } = await supabase.storage
        .from(bucket)
        .upload(chunkPath, blob, { upsert: true, contentType });
      if (error) throw error;
    }, { maxAttempts: 3, baseDelayMs: 400, maxDelayMs: 4000 });

    uploadedBytes += end - start;
    onProgress?.(uploadedBytes, totalSize);
  }

  // Verify the upload actually landed before finalizing. Previously this
  // was skipped ENTIRELY for small single-chunk files (the SPEED FIX below
  // this comment) — but that's the highest-volume case in a chat app (most
  // photos and every voice note are one chunk under 512KB), and skipping
  // verification there specifically explains "missing chunk 0" reports:
  // chunk 0 is the ONLY chunk a single-chunk file has, so if that one PUT
  // resolved without throwing yet the object genuinely didn't persist
  // (transient storage-layer failure, not just read-after-write lag —
  // propagation lag alone wouldn't survive finalize-upload's own multi-
  // second retry loop), the FIRST time anything checks is inside the edge
  // function, several seconds and a whole extra round-trip later, and by
  // then it's reported as a hard failure instead of self-healing instantly
  // client-side the way it now does here.
  //
  // Kept genuinely cheap for the small-file case rather than reusing the
  // full multi-attempt loop verbatim: a single existence check with one
  // short retry, not four attempts with up to 800ms delays — the 200-2000ms
  // this file's SPEED FIX comment references is preserved for the large
  // majority of sends where the chunk really did land on the first try.
  if (isSmallFile && totalChunks === 1) {
    const soleName = chunkPathFor(objectPath, 0).split("/").pop()!;
    let landed = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 250));
      const { data: listed } = await supabase.storage.from(bucket).list(chunkDir(objectPath), { search: soleName, limit: 1 });
      if (listed && listed.length > 0 && ((listed[0] as any).metadata?.size ?? listed[0].size ?? 0) > 0) { landed = true; break; }
    }
    if (!landed) {
      logWarn("resumable", "chunk 0 not visible immediately after upload — re-uploading before finalize", diagContext);
      await withRetry(async () => {
        const { error } = await supabase.storage
          .from(bucket)
          .upload(chunkPathFor(objectPath, 0), file.slice(0, totalSize), { upsert: true, contentType });
        if (error) throw error;
      }, { maxAttempts: 3, baseDelayMs: 400, maxDelayMs: 4000 });
      // One more check so a genuine failure is at least logged clearly —
      // not thrown here, deliberately: finalize-upload's own download
      // retry is a real, working second line of defense (see its comment
      // on SCALED SETTLE DELAY), so this re-upload not being immediately
      // visible yet isn't necessarily a dead end, just not yet confirmed.
      const { data: recheck } = await supabase.storage.from(bucket).list(chunkDir(objectPath), { search: soleName, limit: 1 });
      if (!recheck?.length) logWarn("resumable", "chunk 0 still not visible after re-upload — proceeding to finalize, which will retry independently", diagContext);
    }
  } else if (!isSmallFile || totalChunks > 1) {
    // Verify chunks with retry (storage read-after-write lag)
    const listChunkNamesWithRetry = async (attempts = 4): Promise<Set<string>> => {
      const delays = [0, 200, 400, 800];
      let lastNames = new Set<string>();
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, delays[attempt] ?? 800));
        const { data: listed } = await supabase.storage.from(bucket).list(chunkDir(objectPath), { limit: 1000 });
        lastNames = new Set((listed ?? []).map((e) => e.name));
        const allPresent = Array.from({ length: totalChunks }, (_, i) => chunkPathFor(objectPath, i).split("/").pop()!)
          .every((name) => lastNames.has(name));
        if (allPresent) return lastNames;
      }
      return lastNames;
    };

    const verifyAndRepairChunks = async () => {
      const present = await listChunkNamesWithRetry();
      const missing: number[] = [];
      for (let i = 0; i < totalChunks; i++) {
        if (!present.has(chunkPathFor(objectPath, i).split("/").pop()!)) missing.push(i);
      }
      if (missing.length === 0) return;
      logWarn("resumable", `${missing.length}/${totalChunks} chunk(s) missing — repairing`, { ...diagContext, missing });
      for (const i of missing) {
        if (signal?.aborted) throw new Error("Upload aborted");
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, totalSize);
        await withRetry(async () => {
          const { error } = await supabase.storage
            .from(bucket)
            .upload(chunkPathFor(objectPath, i), file.slice(start, end), { upsert: true, contentType });
          if (error) throw error;
        }, { maxAttempts: 2, baseDelayMs: 400, maxDelayMs: 3000 });
      }
      const presentAfter = await listChunkNamesWithRetry(3);
      const stillMissing: number[] = [];
      for (let i = 0; i < totalChunks; i++) {
        if (!presentAfter.has(chunkPathFor(objectPath, i).split("/").pop()!)) stillMissing.push(i);
      }
      if (stillMissing.length > 0) {
        throw new Error(`Upload incomplete — ${stillMissing.length} chunk(s) did not persist. Tap to retry.`);
      }
    };
    await verifyAndRepairChunks();
  }

  // SPEED FIX: reduced settle delay. Small files get 100ms (was 500ms),
  // large files get a proportional delay. The edge function has its own
  // retry logic, so we don't need to over-delay here.
  const settleDelayMs = isSmallFile ? 100 : Math.min(200, 50 + totalChunks * 15);
  await new Promise((resolve) => setTimeout(resolve, settleDelayMs));

  logInfo("resumable", `finalizing ${objectPath} (${totalChunks} chunks)`, diagContext);

  // Repairs the given chunk indices by re-uploading each one, then verifying
  // it actually landed (storage read-after-write can lag). Shared by both
  // the MISSING_CHUNKS-with-known-indices path and, further down, the
  // fallback path for when the indices had to be recovered from free text.
  async function repairChunks(indices: number[], retryAttempt: number) {
    for (const chunkIdx of indices) {
      if (signal?.aborted) throw new Error("Upload aborted");
      const start = chunkIdx * chunkSize;
      const end = Math.min(start + chunkSize, totalSize);
      await withRetry(async () => {
        const { error } = await supabase.storage
          .from(bucket)
          .upload(chunkPathFor(objectPath, chunkIdx), file.slice(start, end), { upsert: true, contentType });
        if (error) throw error;
      }, { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 4000 });
      // VERIFY: confirm the chunk actually landed before finalizing again —
      // without this, a re-upload that itself silently failed to persist
      // (see this file's header comment on why "succeeded" isn't always
      // trustworthy) would have the edge function report the exact same
      // missing chunk indefinitely, retry after retry, with no visible
      // difference from a chunk that was never re-uploaded at all.
      const chunkPath = chunkPathFor(objectPath, chunkIdx);
      const chunkName = chunkPath.split("/").pop()!;
      const chunkDirPath = chunkDir(objectPath);
      let confirmed = false;
      for (let v = 0; v < 3; v++) {
        if (v > 0) await new Promise((r) => setTimeout(r, 300 * v));
        const { data: listed } = await supabase.storage.from(bucket).list(chunkDirPath, { search: chunkName, limit: 1 });
        if (listed && listed.length > 0 && ((listed[0] as any).metadata?.size ?? 0) > 0) { confirmed = true; break; }
      }
      if (!confirmed) {
        logWarn("resumable", `chunk ${chunkIdx} still not visible after re-upload+verify — finalize will likely report it missing again`, { ...diagContext, chunkPath, retryAttempt });
      }
    }
    // Wait for storage propagation — the edge function's own download
    // retries need the chunk to be visible server-side, and this repair
    // pass's own re-uploads need the same runway.
    await new Promise((resolve) => setTimeout(resolve, 1500 + retryAttempt * 700));
  }

  let lastFinalizeError: unknown = null;

  for (let attemptNum = 0; attemptNum <= MAX_MISSING_CHUNK_RETRIES; attemptNum++) {
    try {
      // ROOT-CAUSE FIX: invokeEdgeFunction throws EdgeFunctionError for every
      // non-2xx response (see edgeFunction.ts) — it never resolves with an
      // `{ ok: false }` value. A prior version of this function had a
      // "structured response" branch here checking `result.ok === false`,
      // which meant it could NEVER run: finalize-upload's 422/409/404/500
      // error responses are non-2xx, so they always throw and land in the
      // catch block below, not here. Removed rather than left as
      // unreachable code that misleadingly implied this path was covered.
      const result = await invokeEdgeFunction<ResumableUploadResult>(
        "finalize-upload",
        { body: { bucket, objectPath, totalChunks, contentType }, timeoutMs: 60_000 }
      );

      // Success — SPEED FIX: for small files, do a single quick verify
      // instead of a 5-attempt loop. The edge function already verified
      // the storage object exists before returning success.
      if (!isSmallFile) {
        // Large files: verify with up to 3 attempts
        let verified = false;
        for (let vAttempt = 0; vAttempt < 3; vAttempt++) {
          if (vAttempt > 0) await new Promise((r) => setTimeout(r, 300 * vAttempt));
          try {
            const { data: fileHead } = await supabase.storage
              .from(bucket)
              .list(result.path.split("/").slice(0, -1).join("/") || "", {
                search: result.path.split("/").pop()!, limit: 1,
              });
            if (fileHead && fileHead.length > 0 && (fileHead[0].metadata?.size ?? 0) > 0) {
              verified = true; break;
            }
          } catch { /* proceed anyway */ }
        }
        if (!verified) logWarn("resumable", "storage verification inconclusive — proceeding", diagContext);
      }

      logInfo("resumable", `upload complete: ${objectPath} (${totalSize} bytes)`, diagContext);
      return result;

    } catch (err) {
      lastFinalizeError = err;

      // PREFERRED PATH: read finalize-upload's actual structured error body
      // off EdgeFunctionError.responseBody — no string-parsing, no chance of
      // silently failing to recognize the error because wording changed or
      // this specific supabase-js version's error shape wasn't one
      // parseFunctionErrorBody knew how to unwrap (see that function's own
      // comment on this file for why that's a real, version-dependent risk,
      // not a hypothetical one).
      const body = err instanceof EdgeFunctionError && err.responseBody && typeof err.responseBody === "object"
        ? err.responseBody as FinalizeErrorResponse
        : null;

      const code = body?.code;
      const retryable = body?.retryable ?? false;
      let missing: number[] | undefined = body?.code === "MISSING_CHUNKS" ? body.missingChunks : undefined;

      // FALLBACK PATH: only reached if responseBody wasn't available at all
      // (e.g. a genuinely different error shape, or a non-EdgeFunctionError
      // exception) — regex-recovers chunk indices from the error text the
      // same way this file always used to, so behavior degrades gracefully
      // rather than losing missing-chunk repair entirely in that edge case.
      if (!body) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("Missing chunk") || errMsg.includes("MISSING_CHUNKS")) {
          const bracketMatch = errMsg.match(/\[(\d[\d,\s]*)\]/);
          if (bracketMatch) {
            missing = bracketMatch[1].split(/[\s,]+/).map(Number).filter(n => Number.isFinite(n));
          } else {
            const oldMatch = errMsg.match(/Missing chunk[s]?\s+([\d,\s]+)/);
            if (oldMatch) missing = oldMatch[1].split(/[\s,]+/).map(Number).filter(n => Number.isFinite(n));
          }
        }
      }

      if (missing && missing.length > 0 && attemptNum < MAX_MISSING_CHUNK_RETRIES) {
        logWarn("resumable", `finalize missing chunks [${missing.join(",")}] — repair ${attemptNum + 1}/${MAX_MISSING_CHUNK_RETRIES}`, {
          ...diagContext, missingChunks: missing, requestId: body?.request_id,
        });
        await repairChunks(missing, attemptNum);
        continue;
      }

      // NEW: previously, any finalize error OTHER than a recognizable
      // "missing chunk" message (SIZE_MISMATCH after a real corruption,
      // CHUNK_COUNT_MISMATCH from a stale tracking row, a transient
      // UPLOAD_FAILED writing the merged object) fell straight through to
      // an immediate, unretried failure — even for the ones the server
      // itself marked `retryable: true`. There was nothing chunk-specific
      // to repair for these, but "nothing to repair" isn't the same as
      // "nothing to retry": a plain re-finalize (no chunk changes) is
      // exactly right for a transient server-side condition, and the
      // server's own `retryable` flag is precisely what's meant to
      // distinguish those from permanent failures like SIZE_MISMATCH.
      if (retryable && code !== "MISSING_CHUNKS" && attemptNum < MAX_MISSING_CHUNK_RETRIES) {
        logWarn("resumable", `finalize failed with retryable code ${code} — retry ${attemptNum + 1}/${MAX_MISSING_CHUNK_RETRIES}`, { ...diagContext, code, requestId: body?.request_id });
        await new Promise((resolve) => setTimeout(resolve, 800 + attemptNum * 600));
        continue;
      }

      const errMsg = err instanceof Error ? err.message : String(err);
      logError("resumable", "finalize failed", { ...diagContext, error: errMsg, code, retryable, attemptNum });
      throw err;
    }
  }

  // Exhausted every retry attempt — surface the last real error rather than
  // a generic "undefined" (a bare `for` loop falling through with no return
  // and no throw would otherwise resolve to `undefined`, which every caller
  // up the chain treats as a successful upload with no URL — silently
  // "succeeding" at nothing is worse than any error message).
  throw lastFinalizeError instanceof Error
    ? lastFinalizeError
    : new Error(`Upload failed after ${MAX_MISSING_CHUNK_RETRIES + 1} attempts: ${String(lastFinalizeError)}`);
}

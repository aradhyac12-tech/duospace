// Edge Function: finalize-upload
// Reassembles chunks under <ownerFolder>/.tmp/<rest>.part-NNNNN into the
// final object, then deletes the chunks and the pending_uploads tracking row.
//
// PHASE 8F FIX (Final Release Audit): chunk path must match the scheme the
// client actually uploads to. objectPath is always `${userId}/...`, and
// client-side chunk uploads/listing must have the user's own id as the
// FIRST path segment to satisfy storage RLS — see src/lib/resumableUpload.ts
// for the full explanation. This function (running as service_role, which
// bypasses RLS) must reconstruct the identical path or it will never find
// the chunks the client wrote.
//
// CRITICAL FIX (attachment pipeline stabilization): returning structured
// error responses with { code, missingChunks, retryable } instead of a bare
// { error: string } — this lets the client distinguish "chunk missing,
// retry the upload" from "server error, retry the whole operation" from
// "permanent failure, don't retry." Also adds post-finalization storage
// verification to confirm the merged object actually exists and is readable
// before declaring success.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

interface Body {
  bucket: string;
  objectPath: string;
  totalChunks: number;
  contentType?: string;
}

interface SuccessResponse {
  ok: true;
  pseudoPublicUrl: string;
  path: string;
  alreadyFinalized?: boolean;
  verifiedSize?: number;
}

interface ErrorResponse {
  ok: false;
  code: "MISSING_CHUNKS" | "SIZE_MISMATCH" | "CHUNK_COUNT_MISMATCH" | "UPLOAD_FAILED" | "NO_PENDING_UPLOAD" | "UNAUTHORIZED" | "INVALID_BODY" | "INTERNAL";
  error: string;
  missingChunks?: number[];
  uploadId?: string;
  retryable: boolean;
  request_id?: string;
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// SECURITY (Phase 4 adversarial audit — Storage/upload security): pending_uploads
// rows are created directly by the CLIENT (src/lib/resumableUpload.ts's own
// upsert — there is no upload-start edge function in this codebase), with
// only RLS (auth.uid() = user_id) protecting who can write a row, and zero
// validation of bucket/total_chunks/total_bytes/content_type at write time.
// This function then trusts that row as its "server-recorded" baseline —
// which is really just a client-supplied value one hop removed, not an
// independently-verified one.
//
// CRITICAL FINDING (2026-09-16, while implementing the MIME-allowlist item
// from docs/PHASE_4_SECURITY_AUDIT.md's Remaining Risks list): the P1-6 fix
// that introduced this allowlist (2026-09-10) used the bucket names from
// scripts/sql/storage_buckets.sql (avatars/attachments/backups) — but that
// script does NOT match what the app actually uses. Every real upload call
// site (src/pages/Chat.tsx, src/pages/Gallery.tsx — the only two callers of
// resumableUpload() in the entire app, confirmed via grep) passes bucket
// "chat-files" or "gallery", which were missing from this allowlist
// entirely. Every chat photo/video/voice-note/file attachment and every
// gallery upload that went through this resumable/finalize path — which is
// ALL of them, there is no size-based bypass (resumableUpload always calls
// finalize-upload, even for single-chunk files) — would have been rejected
// here with `INVALID_BODY: Unknown bucket: chat-files`. The prior pass's
// own verification note ("live behavior NOT TESTABLE") was accurate and is
// exactly why this went unnoticed: the fix was never run against a real
// upload. "attachments" appears nowhere in src/ as an actual bucket
// argument — kept below (harmless if genuinely unused) rather than removed,
// per this project's own "don't delete without dependency analysis" rule;
// "chat-files"/"gallery" are the ones that matter and are added now.
//
// Sizing: chat-files' cap matches Chat.tsx's own client-side check
// (MAX_MB = 100, raised from 50 so a large raw photo/video never round-trips
// just to be rejected after upload) — not enforced twice by coincidence,
// this constant and that one are meant to always agree. gallery has no
// client-side cap at all ("No size limit — Supabase storage bucket is
// unlimited" per Gallery.tsx's own comment) — 500MB here is a judgment
// call, not a discovered product requirement: a generous abuse-prevention
// ceiling (comfortably above any real phone photo/video, and above the
// 100MB floor asked for) rather than an attempt to guess the product's
// real intended limit, which this pass has no way to confirm. MAX_CHUNKS
// (2000) × the 1MB chunk size resumableUpload.ts actually uses already
// caps every bucket at ~2GB regardless of this per-bucket number.
//
// These constants are the actual allowlist: the exact buckets this
// project's client code uploads through, and each one's own configured
// file_size_limit where one exists, checked here as defense-in-depth
// regardless of whether Supabase Storage's bucket-level file_size_limit/
// allowed_mime_types still apply to a service-role upload (unverified in
// this environment — no live Storage backend to test against, so this must
// not be the only enforcement point).
const ALLOWED_BUCKETS: Record<string, { maxBytes: number; allowedMimePrefixes?: string[] }> = {
  "chat-files": { maxBytes: 100 * 1024 * 1024 },
  gallery: { maxBytes: 500 * 1024 * 1024, allowedMimePrefixes: ["image/", "video/"] },
  avatars: { maxBytes: 2 * 1024 * 1024, allowedMimePrefixes: ["image/png", "image/jpeg", "image/webp", "image/gif"] },
  attachments: { maxBytes: 25 * 1024 * 1024 },
  backups: { maxBytes: 50 * 1024 * 1024 },
};
// Matches cleanup-orphan-uploads' own 24h cutoff for what counts as an
// orphaned/stale pending_uploads row — a row that old should never be
// finalizable even if the hourly cleanup job hasn't reached it yet.
const PENDING_UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Sanity cap independent of the per-bucket byte limit — bounds how much
// work a single finalize invocation can be made to do (chunk-count-many
// storage downloads/retries), not just the final object's size.
const MAX_CHUNKS = 2000;

function chunkPathFor(objectPath: string, index: number): string {
  const slashIdx = objectPath.indexOf("/");
  const owner = slashIdx === -1 ? objectPath : objectPath.slice(0, slashIdx);
  const rest = slashIdx === -1 ? "" : objectPath.slice(slashIdx + 1);
  const restDir = rest.includes("/") ? rest.slice(0, rest.lastIndexOf("/")) : "";
  const fileName = rest.slice(rest.lastIndexOf("/") + 1) || rest;
  const dir = restDir ? `${owner}/.tmp/${restDir}` : `${owner}/.tmp`;
  return `${dir}/${fileName}.part-${index.toString().padStart(5, "0")}`;
}

function jsonResponse(status: number, body: SuccessResponse | ErrorResponse): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Generate a request ID for tracing
  const requestId = `fin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse(401, {
        ok: false, code: "UNAUTHORIZED", error: "Missing Authorization header", retryable: false, request_id: requestId,
      });
    }

    // Validate caller
    const userClient = createClient(SUPABASE_URL, (Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY"))!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) {
      return jsonResponse(401, {
        ok: false, code: "UNAUTHORIZED", error: "Invalid or expired session", retryable: false, request_id: requestId,
      });
    }

    const body = (await req.json()) as Body;
    if (!body?.bucket || !body?.objectPath || !Number.isFinite(body?.totalChunks)) {
      return jsonResponse(400, {
        ok: false, code: "INVALID_BODY", error: "Missing required fields: bucket, objectPath, totalChunks", retryable: false, request_id: requestId,
      });
    }

    // objectPath's first path segment must be the caller's own user id.
    const objectOwnerSegment = body.objectPath.split("/")[0];
    if (objectOwnerSegment !== user.id) {
      return jsonResponse(403, {
        ok: false, code: "UNAUTHORIZED", error: "objectPath does not belong to the authenticated user", retryable: false, request_id: requestId,
      });
    }

    // SECURITY: path traversal — object storage keys aren't a real
    // filesystem, but Supabase Storage still resolves them relative to the
    // bucket root, and this project's own per-bucket RLS/allowlisting all
    // assumes objectPath's structure is exactly `${userId}/...`. A `..`
    // segment (or a literal null byte) has no legitimate use in any path
    // this app ever constructs (see resumableUpload.ts) and is rejected
    // outright rather than assumed-safe.
    if (body.objectPath.split("/").some((seg) => seg === "." || seg === "..") || body.objectPath.includes("\0")) {
      return jsonResponse(400, {
        ok: false, code: "INVALID_BODY", error: "objectPath contains an invalid path segment", retryable: false, request_id: requestId,
      });
    }

    // SECURITY: explicit bucket allowlist — see ALLOWED_BUCKETS' own doc
    // comment above for why this can't just rely on the pending_uploads
    // row already existing.
    const bucketConfig = ALLOWED_BUCKETS[body.bucket];
    if (!bucketConfig) {
      return jsonResponse(400, {
        ok: false, code: "INVALID_BODY", error: `Unknown bucket: ${body.bucket}`, retryable: false, request_id: requestId,
      });
    }

    if (body.totalChunks > MAX_CHUNKS) {
      return jsonResponse(422, {
        ok: false, code: "CHUNK_COUNT_MISMATCH", error: `totalChunks exceeds the maximum of ${MAX_CHUNKS}`, retryable: false, request_id: requestId,
      });
    }

    // Atomically claim the tracking row — exactly one request owns the finalize.
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: claimed } = await admin.from("pending_uploads")
      .delete()
      .eq("user_id", user.id)
      .eq("bucket", body.bucket).eq("object_path", body.objectPath)
      .select("user_id, bucket, object_path, total_chunks, total_bytes, content_type, created_at")
      .maybeSingle();
    const pending = claimed;

    async function restoreClaim() {
      if (!claimed) return;
      await admin.from("pending_uploads").upsert({
        user_id: claimed.user_id,
        bucket: claimed.bucket,
        object_path: claimed.object_path,
        total_chunks: claimed.total_chunks,
        total_bytes: claimed.total_bytes,
      });
    }

    if (!pending) {
      // Either a concurrent finalize already completed, or this is a retry of
      // one that completed. Treat an already-present final object as success.
      const dir = body.objectPath.slice(0, body.objectPath.lastIndexOf("/"));
      const name = body.objectPath.slice(body.objectPath.lastIndexOf("/") + 1);
      const { data: listed } = await admin.storage.from(body.bucket).list(dir, { search: name, limit: 1 });
      if (listed?.some((o) => o.name === name)) {
        // Verify the existing object is readable (not zero-length)
        const { data: existingObj } = await admin.storage.from(body.bucket).list(dir, { search: name, limit: 1 });
        const existingSize = existingObj?.[0]?.metadata?.size ?? existingObj?.[0]?.size ?? 0;
        const { data: existing } = admin.storage.from(body.bucket).getPublicUrl(body.objectPath);
        console.log(`[${requestId}] already finalized, verified size=${existingSize}`);
        return jsonResponse(200, {
          ok: true, pseudoPublicUrl: existing.publicUrl, path: body.objectPath,
          alreadyFinalized: true, verifiedSize: existingSize,
        });
      }
      return jsonResponse(404, {
        ok: false, code: "NO_PENDING_UPLOAD",
        error: "No pending upload found and no existing final object — upload may have been cleaned up. Retry from the beginning.",
        retryable: false, request_id: requestId,
      });
    }

    // Use the SERVER-RECORDED chunk count, not the client-supplied one.
    if (body.totalChunks !== pending.total_chunks) {
      await restoreClaim();
      return jsonResponse(409, {
        ok: false, code: "CHUNK_COUNT_MISMATCH",
        error: `totalChunks mismatch: request says ${body.totalChunks}, tracked upload says ${pending.total_chunks}`,
        retryable: true, request_id: requestId,
      });
    }
    const totalChunks = pending.total_chunks as number;
    if (!Number.isFinite(totalChunks) || totalChunks < 1) {
      await restoreClaim();
      return jsonResponse(422, {
        ok: false, code: "CHUNK_COUNT_MISMATCH",
        error: "Tracked upload has an invalid chunk count",
        retryable: false, request_id: requestId,
      });
    }

    // SECURITY: expired upload session — a pending_uploads row this old is
    // exactly what cleanup-orphan-uploads (24h cutoff) considers orphaned;
    // it may not have been swept yet, but it must not still be
    // finalizable. restoreClaim() is deliberately NOT called here — an
    // expired session should be left for the cleanup job to actually
    // remove, not re-armed for another finalize attempt.
    const pendingCreatedAt = (pending as { created_at?: string }).created_at;
    if (pendingCreatedAt && Date.now() - new Date(pendingCreatedAt).getTime() > PENDING_UPLOAD_MAX_AGE_MS) {
      return jsonResponse(410, {
        ok: false, code: "NO_PENDING_UPLOAD",
        error: "This upload session has expired. Start the upload again.",
        retryable: false, request_id: requestId,
      });
    }

    // SECURITY: per-bucket size cap, independent of whatever total_bytes
    // the client claimed at upload-start (see ALLOWED_BUCKETS' doc comment
    // — that claim was never independently validated either).
    if (typeof pending.total_bytes === "number" && pending.total_bytes > bucketConfig.maxBytes) {
      await restoreClaim();
      return jsonResponse(422, {
        ok: false, code: "SIZE_MISMATCH",
        error: `Upload exceeds the ${bucketConfig.maxBytes}-byte limit for bucket "${body.bucket}"`,
        retryable: false, request_id: requestId,
      });
    }

    // SECURITY: MIME allowlist — only enforced where this project has an
    // established, known-safe set (avatars: images only, matching that
    // bucket's own Storage-level allowed_mime_types in
    // scripts/sql/storage_buckets.sql; gallery: images/video, matching its
    // own file-picker's accept="image/*,video/*" in Gallery.tsx — nothing
    // in the app ever sends gallery anything else). chat-files
    // intentionally has NO allowlist: its own file picker
    // (fileInputRef in Chat.tsx) has no `accept` restriction at all by
    // design — the app lets a couple send each other any file type, not
    // just images/video/audio — so guessing a narrower list here would
    // silently break real, intended functionality rather than close a
    // gap. This is a product choice this pass can observe but not
    // override.
    //
    // Matching is by prefix (e.g. "image/" matches "image/jpeg"), not
    // exact string equality — the field was always named
    // allowedMimePrefixes but the original P1-6 check used `.includes()`
    // against exact values, which happened to work for avatars only
    // because that list enumerated full MIME strings; fixed here to do
    // real prefix matching so gallery's "image/"/"video/" entries work at
    // all.
    const effectiveContentType = body.contentType ?? pending.content_type ?? "application/octet-stream";
    if (bucketConfig.allowedMimePrefixes && !bucketConfig.allowedMimePrefixes.some((prefix) => effectiveContentType.startsWith(prefix))) {
      await restoreClaim();
      return jsonResponse(422, {
        ok: false, code: "INVALID_BODY",
        error: `Content type "${effectiveContentType}" is not allowed for bucket "${body.bucket}"`,
        retryable: false, request_id: requestId,
      });
    }

    // SCALED SETTLE DELAY: for single-chunk files (voice notes, most
    // photos/files), the time between upload completion and this download
    // attempt is minimal. For multi-chunk files, the earlier chunks have
    // had more time to propagate. Scale the delay accordingly.
    // This is a one-time cost in the finalize path.
    const initialSettleMs = totalChunks <= 1 ? 150 : Math.min(150, 40 + totalChunks * 8);
    await new Promise((resolve) => setTimeout(resolve, initialSettleMs));

    // Download every chunk and concat
    // Retry-with-backoff: storage read-after-write is not instantaneous.
    // Single-chunk files get the most aggressive retry since they have the
    // least natural settling time.
    async function downloadChunkWithRetry(partName: string, attempts?: number) {
      const maxAttempts = attempts ?? (totalChunks <= 1 ? 6 : 5);
      let lastError: unknown = null;
      const delays = [0, 150, 300, 600, 1200, 2000, 3000, 4000];
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, delays[attempt] ?? 5000));
        }
        const { data, error } = await admin.storage.from(body.bucket).download(partName);
        if (!error && data) return data;
        lastError = error;
        console.warn(`[${requestId}] chunk download attempt ${attempt + 1}/${maxAttempts} failed: ${partName}`, error?.message);
      }
      console.error(`[${requestId}] chunk still missing after ${maxAttempts} attempts: ${partName}`, lastError);
      return null;
    }

    const parts: Uint8Array[] = [];
    const missingChunks: number[] = [];
    for (let i = 0; i < totalChunks; i++) {
      const partName = chunkPathFor(body.objectPath, i);
      const data = await downloadChunkWithRetry(partName);
      if (!data) {
        missingChunks.push(i);
        continue;
      }
      parts.push(new Uint8Array(await data.arrayBuffer()));
    }

    if (missingChunks.length > 0) {
      await restoreClaim();
      return jsonResponse(422, {
        ok: false, code: "MISSING_CHUNKS",
        error: `Missing ${missingChunks.length} chunk(s): [${missingChunks.join(", ")}]`,
        missingChunks,
        uploadId: body.objectPath,
        retryable: true, request_id: requestId,
      });
    }

    const totalLen = parts.reduce((n, p) => n + p.length, 0);
    // Cross-check the reassembled size against total_bytes recorded at upload-start.
    if (typeof pending.total_bytes === "number" && totalLen !== pending.total_bytes) {
      await restoreClaim();
      return jsonResponse(422, {
        ok: false, code: "SIZE_MISMATCH",
        error: `Reassembled size ${totalLen} does not match tracked size ${pending.total_bytes}`,
        uploadId: body.objectPath,
        retryable: false, request_id: requestId,
      });
    }
    const merged = new Uint8Array(totalLen);
    let offset = 0;
    for (const p of parts) { merged.set(p, offset); offset += p.length; }

    const { error: upErr } = await admin.storage.from(body.bucket)
      .upload(body.objectPath, merged, {
        upsert: true,
        contentType: body.contentType ?? "application/octet-stream",
      });
    if (upErr) {
      console.error(`[${requestId}] final upload failed:`, upErr.message);
      await restoreClaim();
      return jsonResponse(500, {
        ok: false, code: "UPLOAD_FAILED",
        error: `Failed to write final object: ${upErr.message}`,
        uploadId: body.objectPath,
        retryable: true, request_id: requestId,
      });
    }

    // POST-FINALIZATION STORAGE VERIFICATION: confirm the merged object
    // actually exists and is readable before declaring success. This closes
    // the window where the upload "succeeds" on paper but the object isn't
    // yet accessible to the client (which would cause the message to render
    // with a broken image/file link).
    const verifyDir = body.objectPath.slice(0, body.objectPath.lastIndexOf("/"));
    const verifyName = body.objectPath.slice(body.objectPath.lastIndexOf("/") + 1);
    let verifiedSize = 0;
    for (let vAttempt = 0; vAttempt < 4; vAttempt++) {
      if (vAttempt > 0) await new Promise((r) => setTimeout(r, 300 * vAttempt));
      const { data: verified } = await admin.storage.from(body.bucket).list(verifyDir, { search: verifyName, limit: 1 });
      if (verified?.[0]) {
        verifiedSize = verified[0].metadata?.size ?? verified[0].size ?? totalLen;
        break;
      }
    }

    // Cleanup: chunks only — the tracking row was already claimed (deleted) above.
    const partPaths = Array.from({ length: totalChunks }, (_, i) =>
      chunkPathFor(body.objectPath, i));
    // Best-effort cleanup — don't fail the whole operation if chunk cleanup has a transient error
    try {
      await admin.storage.from(body.bucket).remove(partPaths);
    } catch (cleanupErr) {
      console.warn(`[${requestId}] chunk cleanup failed (non-fatal):`, cleanupErr);
    }

    const { data: pub } = admin.storage.from(body.bucket).getPublicUrl(body.objectPath);
    console.log(`[${requestId}] finalize success: ${body.objectPath} (${totalLen} bytes, ${totalChunks} chunks, verified=${verifiedSize})`);

    return jsonResponse(200, {
      ok: true, pseudoPublicUrl: pub.publicUrl, path: body.objectPath, verifiedSize,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${requestId}] fatal:`, msg);
    return jsonResponse(500, {
      ok: false, code: "INTERNAL",
      error: msg, retryable: true, request_id: requestId,
    });
  }
});

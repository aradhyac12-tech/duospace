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

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

interface Body {
  bucket: string;
  objectPath: string;
  totalChunks: number;
  contentType?: string;
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function chunkPathFor(objectPath: string, index: number): string {
  const slashIdx = objectPath.indexOf("/");
  const owner = slashIdx === -1 ? objectPath : objectPath.slice(0, slashIdx);
  const rest = slashIdx === -1 ? "" : objectPath.slice(slashIdx + 1);
  const restDir = rest.includes("/") ? rest.slice(0, rest.lastIndexOf("/")) : "";
  const fileName = rest.slice(rest.lastIndexOf("/") + 1) || rest;
  const dir = restDir ? `${owner}/.tmp/${restDir}` : `${owner}/.tmp`;
  return `${dir}/${fileName}.part-${index.toString().padStart(5, "0")}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Validate caller
    const userClient = createClient(SUPABASE_URL, (Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY"))!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const body = (await req.json()) as Body;
    if (!body?.bucket || !body?.objectPath || !Number.isFinite(body?.totalChunks)) {
      return new Response(JSON.stringify({ error: "Invalid body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // PHASE 8.5 FIX (item 6/7 — storage contract + resumable reliability):
    // objectPath's first path segment must be the caller's own user id.
    // This was previously enforced only indirectly (chunk uploads would fail
    // storage RLS if aimed at another user's folder), which is real
    // protection for the CHUNK writes but does nothing to stop the FINAL
    // merged-object write below, since that write runs as service_role and
    // bypasses storage RLS entirely. Explicit check here, not just reliance
    // on the pending_uploads row (which — see below — is also not a
    // sufficient check on its own).
    const objectOwnerSegment = body.objectPath.split("/")[0];
    if (objectOwnerSegment !== user.id) {
      return new Response(JSON.stringify({ error: "objectPath does not belong to the authenticated user" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Verify the user owns this pending upload AND pull the server-recorded
    // total_chunks/total_bytes — the client-supplied body.totalChunks is
    // NOT trusted as the loop bound (see fix below). Previously this only
    // selected user_id and never compared body.bucket/body.objectPath
    // against anything beyond the .eq() filter used to find the row, which
    // is equivalent but worth being explicit about: the filter IS the
    // ownership check, not an afterthought.
    // STABILIZATION FIX (concurrency / idempotency): the tracking row is now
    // *claimed* with an atomic delete-returning instead of being selected
    // here and deleted at the end. Previously two simultaneous finalize
    // requests for the same upload both passed this SELECT, both downloaded
    // the chunks, both wrote the merged object, and whichever finished first
    // deleted the chunks — so the loser failed with a bogus "Missing chunk"
    // 422 even though the file had in fact been finalized correctly.
    //
    // With the claim, exactly one request owns the finalize. A second
    // concurrent (or retried) request finds no row and returns the same
    // success payload it would have produced — finalize is idempotent. If
    // the claiming request then fails, it restores the row so the client can
    // legitimately retry.
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: claimed } = await admin.from("pending_uploads")
      .delete()
      .eq("user_id", user.id)
      .eq("bucket", body.bucket).eq("object_path", body.objectPath)
      .select("user_id, bucket, object_path, total_chunks, total_bytes")
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
        const { data: existing } = admin.storage.from(body.bucket).getPublicUrl(body.objectPath);
        return new Response(JSON.stringify({ pseudoPublicUrl: existing.publicUrl, path: body.objectPath, alreadyFinalized: true }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "No pending upload found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // PHASE 8.5 FIX: use the SERVER-RECORDED chunk count, not the
    // client-supplied one. Previously `body.totalChunks` alone controlled
    // the reassembly loop. Concretely, a client could set totalChunks to 0
    // (no chunks required at all) and finalize an EMPTY object at any
    // objectPath satisfying the ownership check above — including
    // overwriting an existing file at that path via `upsert: true`. Using
    // the value recorded when the upload was tracked (which reflects the
    // real file size computed client-side at upload-start time) closes
    // that gap. A mismatch between what the client now claims and what was
    // recorded is treated as suspicious and rejected outright rather than
    // silently preferring one value.
    if (body.totalChunks !== pending.total_chunks) {
      await restoreClaim();
      return new Response(JSON.stringify({
        error: `totalChunks mismatch: request says ${body.totalChunks}, tracked upload says ${pending.total_chunks}`,
      }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const totalChunks = pending.total_chunks as number;
    if (!Number.isFinite(totalChunks) || totalChunks < 1) {
      await restoreClaim();
      return new Response(JSON.stringify({ error: "Tracked upload has an invalid chunk count" }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Download every chunk and concat
    const parts: Uint8Array[] = [];
    for (let i = 0; i < totalChunks; i++) {
      const partName = chunkPathFor(body.objectPath, i);
      const { data, error } = await admin.storage.from(body.bucket).download(partName);
      if (error || !data) {
        await restoreClaim();
        return new Response(JSON.stringify({ error: `Missing chunk ${i}` }),
          { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      parts.push(new Uint8Array(await data.arrayBuffer()));
    }

    const totalLen = parts.reduce((n, p) => n + p.length, 0);
    // PHASE 8.5 FIX: cross-check the reassembled size against total_bytes
    // recorded at upload-start. This catches a truncated/corrupted chunk
    // set (e.g. a chunk that re-uploaded shorter than intended after a
    // resume) before it's written as the final object, rather than
    // silently finalizing a wrong-sized file.
    if (typeof pending.total_bytes === "number" && totalLen !== pending.total_bytes) {
      await restoreClaim();
      return new Response(JSON.stringify({
        error: `Reassembled size ${totalLen} does not match tracked size ${pending.total_bytes}`,
      }), { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
      console.error("[finalize-upload] final upload failed:", upErr.message);
      await restoreClaim();
      return new Response(JSON.stringify({ error: upErr.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Cleanup: chunks only — the tracking row was already claimed (deleted)
    // atomically above.
    const partPaths = Array.from({ length: totalChunks }, (_, i) =>
      chunkPathFor(body.objectPath, i));
    await admin.storage.from(body.bucket).remove(partPaths);

    // NOTE: getPublicUrl() just string-templates a "/object/public/..." path —
    // it does not check bucket visibility. This bucket is private; the field
    // is named pseudoPublicUrl (not publicUrl) so callers don't treat it as a
    // directly-loadable link. See ResumableUploadResult in
    // src/lib/resumableUpload.ts for the full rationale — kept in this shape
    // deliberately to match the existing file_url storage convention used
    // app-wide, resolved to a real URL at render time via signedStorageUrl.ts.
    const { data: pub } = admin.storage.from(body.bucket).getPublicUrl(body.objectPath);
    return new Response(JSON.stringify({ pseudoPublicUrl: pub.publicUrl, path: body.objectPath }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[finalize-upload] fatal:", msg);
    return new Response(JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});

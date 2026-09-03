// Edge Function: cleanup-orphan-uploads
// Cron-friendly. Deletes pending_uploads rows older than 24h and removes
// any leftover chunk files under .tmp/ for that object path.
//
// ROOT-CAUSE FIX (found during the "Missing chunk 0" investigation): this
// computed orphaned chunk paths as `.tmp/${object_path}.part-N` — a
// top-level `.tmp` folder with the whole object_path (which already starts
// with the owning user's id) nested inside it. That has never matched the
// path convention resumableUpload.ts actually uploads to and
// finalize-upload actually reads from: `${owner}/.tmp/${restDir?}/
// ${fileName}.part-N` (the OWNER'S folder first, `.tmp` nested inside it —
// required so the first path segment is auth.uid() for storage RLS; see
// resumableUpload.ts's PHASE 8F FIX comment). Storage .remove() on a path
// that doesn't exist is a silent no-op, so this has been cleaning up
// nothing for real abandoned uploads — their actual chunk files under
// `${owner}/.tmp/...` were never removed, only ever accumulating. Not
// itself the cause of the live "Missing chunk 0" failures (real chunks
// were left alone, not deleted), but a real storage-hygiene bug worth
// fixing on its own, and exactly the kind of thing this investigation was
// asked to check ("cleanup deleting chunk 0" / stale cleanup assumptions).
// Fixed by reusing the identical path-construction logic as the other two
// files instead of a third, independently-typed-out version of it.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

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

  // Require service role for cron-only invocation
  const auth = req.headers.get("Authorization") ?? "";
  if (auth !== `Bearer ${SERVICE_KEY}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: orphans, error } = await admin.from("pending_uploads")
    .select("id, bucket, object_path, total_chunks")
    .lt("created_at", cutoff);

  if (error) {
    console.error("[cleanup-orphan-uploads] list failed:", error.message);
    return new Response(JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  let removed = 0;
  for (const row of orphans ?? []) {
    const partPaths = Array.from({ length: row.total_chunks }, (_, i) =>
      chunkPathFor(row.object_path, i));
    try {
      await admin.storage.from(row.bucket).remove(partPaths);
      await admin.from("pending_uploads").delete().eq("id", row.id);
      removed++;
    } catch (e) {
      console.error("[cleanup-orphan-uploads] failed for", row.object_path, e);
    }
  }

  return new Response(JSON.stringify({ removed, scanned: orphans?.length ?? 0 }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
});

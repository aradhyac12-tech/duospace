// Edge Function: cleanup-orphan-uploads
// Cron-friendly. Deletes pending_uploads rows older than 24h and removes
// any leftover chunk files under .tmp/ for that object path.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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
      `.tmp/${row.object_path}.part-${i.toString().padStart(5, "0")}`);
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

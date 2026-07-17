// Edge Function: finalize-upload
// Reassembles chunks under .tmp/<objectPath>.part-NNNNN into the final object,
// then deletes the chunks and the pending_uploads tracking row.

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

    // Verify the user owns this pending upload
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: pending } = await admin.from("pending_uploads")
      .select("user_id").eq("user_id", user.id)
      .eq("bucket", body.bucket).eq("object_path", body.objectPath).maybeSingle();
    if (!pending) {
      return new Response(JSON.stringify({ error: "No pending upload found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Download every chunk and concat
    const parts: Uint8Array[] = [];
    for (let i = 0; i < body.totalChunks; i++) {
      const partName = `.tmp/${body.objectPath}.part-${i.toString().padStart(5, "0")}`;
      const { data, error } = await admin.storage.from(body.bucket).download(partName);
      if (error || !data) {
        return new Response(JSON.stringify({ error: `Missing chunk ${i}` }),
          { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      parts.push(new Uint8Array(await data.arrayBuffer()));
    }

    const totalLen = parts.reduce((n, p) => n + p.length, 0);
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
      return new Response(JSON.stringify({ error: upErr.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Cleanup: chunks + tracking row
    const partPaths = Array.from({ length: body.totalChunks }, (_, i) =>
      `.tmp/${body.objectPath}.part-${i.toString().padStart(5, "0")}`);
    await admin.storage.from(body.bucket).remove(partPaths);
    await admin.from("pending_uploads")
      .delete().eq("user_id", user.id)
      .eq("bucket", body.bucket).eq("object_path", body.objectPath);

    const { data: pub } = admin.storage.from(body.bucket).getPublicUrl(body.objectPath);
    return new Response(JSON.stringify({ publicUrl: pub.publicUrl, path: body.objectPath }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[finalize-upload] fatal:", msg);
    return new Response(JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});

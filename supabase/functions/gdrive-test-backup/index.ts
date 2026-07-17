// gdrive-test-backup
// Uploads a tiny JSON payload to the user's Google Drive appDataFolder.
// Logs a row in backup_runs and updates last-backup fields on user_secrets.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const GATEWAY = "https://connector-gateway.lovable.dev";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

  const authHeader = req.headers.get("Authorization") ?? "";
  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = (Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY"))!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const userClient = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: jsonHeaders });
  }

  const admin = createClient(url, service, { auth: { persistSession: false } });
  const { data: secrets } = await admin
    .from("user_secrets")
    .select("google_drive_refresh_token")
    .eq("user_id", user.id)
    .maybeSingle();

  const connectionKey = secrets?.google_drive_refresh_token;
  if (!connectionKey) {
    return new Response(JSON.stringify({ error: "Google Drive not connected" }), { status: 400, headers: jsonHeaders });
  }

  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY")!;
  const now = new Date().toISOString();
  const payload = {
    kind: "duospace-test-backup",
    user_id: user.id,
    created_at: now,
    note: "Test backup verifying Google Drive connection.",
  };
  const payloadStr = JSON.stringify(payload, null, 2);
  const size = new TextEncoder().encode(payloadStr).length;

  const boundary = "----duospace" + crypto.randomUUID().replace(/-/g, "");
  const metadata = {
    name: `duospace-test-${Date.now()}.json`,
    parents: ["appDataFolder"],
    mimeType: "application/json",
  };
  const multipart =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) + `\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    payloadStr + `\r\n` +
    `--${boundary}--`;

  let status: "success" | "error" = "success";
  let fileId: string | null = null;
  let errText: string | null = null;

  try {
    const upRes = await fetch(
      `${GATEWAY}/google_drive/upload/drive/v3/files?uploadType=multipart&fields=id,name,size`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "X-App-User-Connection-Key": connectionKey,
          "Content-Type": `multipart/related; boundary=${boundary}`,
        },
        body: multipart,
      },
    );
    const body = await upRes.text();
    if (!upRes.ok) {
      status = "error";
      errText = `[${upRes.status}] ${body.slice(0, 500)}`;
    } else {
      const j = JSON.parse(body);
      fileId = j?.id ?? null;
    }
  } catch (e) {
    status = "error";
    errText = e instanceof Error ? e.message : String(e);
  }

  await admin.from("backup_runs").insert({
    user_id: user.id,
    provider: "google_drive",
    status,
    file_id: fileId,
    size_bytes: status === "success" ? size : null,
    error: errText,
  });

  if (status === "success") {
    await admin.from("user_secrets").update({
      last_backup_at: now,
      last_backup_file_id: fileId,
      last_backup_size: size,
      last_backup_error: null,
    }).eq("user_id", user.id);
  } else {
    await admin.from("user_secrets").update({
      last_backup_error: errText,
    }).eq("user_id", user.id);
  }

  return new Response(JSON.stringify({
    status,
    file_id: fileId,
    size_bytes: size,
    error: errText,
  }), { status: status === "success" ? 200 : 502, headers: jsonHeaders });
});

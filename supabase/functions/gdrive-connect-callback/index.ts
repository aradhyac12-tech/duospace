// gdrive-connect-callback
// Called by the client after the gateway redirects back with a connection_key.
// Stores the key in user_secrets and fetches the connected Google account email.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders } from "../_shared/cors.ts";

const GATEWAY = "https://connector-gateway.lovable.dev";

const BodySchema = z.object({
  connection_key: z.string().min(8).max(4096),
});

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

  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: "Missing connection_key" }), { status: 400, headers: jsonHeaders });
  }
  const { connection_key } = parsed.data;

  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY")!;

  // Best-effort: fetch the connected Google account email via Drive About endpoint.
  let email: string | null = null;
  try {
    const aboutRes = await fetch(`${GATEWAY}/google_drive/drive/v3/about?fields=user`, {
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "X-App-User-Connection-Key": connection_key,
      },
    });
    if (aboutRes.ok) {
      const j = await aboutRes.json();
      email = j?.user?.emailAddress ?? null;
    } else {
      console.error("gdrive about failed", aboutRes.status, await aboutRes.text());
    }
  } catch (e) {
    console.error("gdrive about exception", e);
  }

  const admin = createClient(url, service, { auth: { persistSession: false } });
  const { error: upErr } = await admin
    .from("user_secrets")
    .upsert({
      user_id: user.id,
      google_drive_refresh_token: connection_key,
      google_drive_email: email,
      google_drive_connected_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
  if (upErr) {
    return new Response(JSON.stringify({ error: upErr.message }), { status: 500, headers: jsonHeaders });
  }
  return new Response(JSON.stringify({ ok: true, email }), { headers: jsonHeaders });
});

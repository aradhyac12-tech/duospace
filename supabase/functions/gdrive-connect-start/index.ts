// gdrive-connect-start
// Starts a per-user Google Drive OAuth via the Lovable App User Connector gateway.
// Returns the authorize URL the client should open.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders } from "../_shared/cors.ts";

const GATEWAY = "https://connector-gateway.lovable.dev";
const SCOPES = [
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/drive.appdata",
];

const BodySchema = z.object({
  redirect_uri: z.string().url().max(500),
});

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

  const authHeader = req.headers.get("Authorization") ?? "";
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    (Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY"))!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: jsonHeaders });
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: "Invalid input" }), { status: 400, headers: jsonHeaders });
  }

  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  const CLIENT_API_KEY = Deno.env.get("GOOGLE_DRIVE_APP_USER_CONNECTOR_CLIENT_API_KEY");
  if (!LOVABLE_API_KEY || !CLIENT_API_KEY) {
    return new Response(JSON.stringify({ error: "Google Drive connector is not configured on the server." }),
      { status: 500, headers: jsonHeaders });
  }

  const state = crypto.randomUUID();
  const res = await fetch(`${GATEWAY}/api/v1/app-users/oauth2/authorize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LOVABLE_API_KEY}`,
      "X-App-User-Connector-Client-Api-Key": CLIENT_API_KEY,
    },
    body: JSON.stringify({
      connector_id: "google_drive",
      credentials_configuration: { scopes: SCOPES },
      redirect_uri: parsed.data.redirect_uri,
      state,
    }),
  });

  const body = await res.text();
  if (!res.ok) {
    console.error("gdrive-connect-start: gateway error", res.status, body);
    return new Response(JSON.stringify({ error: "Failed to start Google connection", status: res.status, details: body }),
      { status: res.status, headers: jsonHeaders });
  }

  let parsedBody: Record<string, unknown> = {};
  try { parsedBody = JSON.parse(body); } catch { /* fallthrough */ }
  const authorizeUrl =
    (parsedBody.authorize_url as string) ??
    (parsedBody.authorization_url as string) ??
    (parsedBody.url as string);
  if (!authorizeUrl) {
    return new Response(JSON.stringify({ error: "Gateway did not return authorize URL", raw: body }),
      { status: 502, headers: jsonHeaders });
  }
  return new Response(JSON.stringify({ authorize_url: authorizeUrl, state }), { headers: jsonHeaders });
});

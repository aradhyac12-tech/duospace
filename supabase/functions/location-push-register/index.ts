/**
 * location-push-register — issues (or rotates) the per-device credential the
 * Android native layer uses to upload a location fix when a text/call push
 * wakes the app while it is closed (KI-12 gap 2).
 *
 * Requires a normal signed-in session (verify_jwt = true). Generates a random
 * 256-bit secret, stores ONLY its SHA-256 hash, and returns the secret once.
 * Calling it again for the same (user, device) rotates the secret, which
 * invalidates the previous one.
 *
 * NOT RUNTIME-VERIFIED end to end from a real device.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Inlined (not imported from ../_shared/cors.ts) so this function deploys as a
// single self-contained file.
const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

function base64url(bytes: Uint8Array): string {
  let bin = "";
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(
    supabaseUrl,
    (Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY"))!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) return json({ error: "Unauthorized" }, 401);

  let body: { device_id?: unknown };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const deviceId = typeof body.device_id === "string" ? body.device_id.trim() : "";
  if (deviceId.length < 1 || deviceId.length > 100) return json({ error: "Invalid device_id" }, 400);

  const secret = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const secretHash = await sha256Hex(secret);

  const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data, error } = await admin
    .from("location_push_credentials")
    .upsert(
      { user_id: user.id, device_id: deviceId, secret_hash: secretHash, created_at: new Date().toISOString(), last_used_at: null },
      { onConflict: "user_id,device_id" },
    )
    .select("id")
    .single();
  if (error || !data) return json({ error: "Could not register device" }, 500);

  return json({
    credential_id: data.id,
    secret,
    upload_url: `${supabaseUrl}/functions/v1/location-push-upload`,
  });
});

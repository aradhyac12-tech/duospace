// Edge function: webauthn-register-verify
// Auth: signed-in user. Verifies attestation and stores the new credential.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyRegistrationResponse } from "npm:@simplewebauthn/server@13.3.0";
import { corsHeaders } from "../_shared/cors.ts";
import { getWebauthnConfig } from "../_shared/webauthnOrigin.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = (Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY"))!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
    const supa = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: uErr } = await supa.auth.getUser();
    if (uErr || !user) return json({ error: "Unauthorized" }, 401);

    const body = await req.json().catch(() => null) as
      | { response?: unknown; device_name?: string }
      | null;
    if (!body?.response) return json({ error: "Missing response" }, 400);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    const { data: chal } = await admin
      .from("webauthn_challenges")
      .select("id, challenge, expires_at")
      .eq("user_id", user.id)
      .eq("kind", "registration")
      .is("consumed_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!chal) return json({ error: "No pending challenge" }, 400);
    if (new Date(chal.expires_at).getTime() < Date.now()) {
      return json({ error: "Challenge expired" }, 400);
    }

    const { rpID, origins } = getWebauthnConfig(req);
    const verification = await verifyRegistrationResponse({
      response: body.response as never,
      expectedChallenge: chal.challenge,
      expectedOrigin: origins,
      expectedRPID: rpID,
      requireUserVerification: false,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return json({ error: "Verification failed" }, 400);
    }

    const info = verification.registrationInfo;
    const credId = toBase64Url(info.credential.id);
    const pubKey = base64UrlEncode(info.credential.publicKey);

    const { error: insErr } = await admin.from("webauthn_credentials").insert({
      user_id: user.id,
      credential_id: credId,
      public_key: pubKey,
      counter: info.credential.counter,
      transports: info.credential.transports
        ?? (body.response as { response?: { transports?: string[] } })?.response?.transports
        ?? [],
      device_name: body.device_name ?? null,
      aaguid: info.aaguid ?? null,
    });
    if (insErr) throw insErr;

    await admin.from("webauthn_challenges")
      .update({ consumed_at: new Date().toISOString() })
      .eq("id", chal.id);

    return json({ verified: true, credential_id: credId }, 200);
  } catch (e) {
    console.error("[webauthn-register-verify]", e);
    return json({ error: e instanceof Error ? e.message : "Internal error" }, 500);
  }
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function base64UrlEncode(buf: Uint8Array | ArrayBuffer): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toBase64Url(value: string | Uint8Array | ArrayBuffer): string {
  return typeof value === "string" ? value : base64UrlEncode(value);
}

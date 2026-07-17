// Edge function: webauthn-register-options
// Auth: signed-in user. Returns PublicKeyCredentialCreationOptionsJSON for
// registering a new passkey.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { generateRegistrationOptions } from "npm:@simplewebauthn/server@13.3.0";
import { corsHeaders } from "../_shared/cors.ts";
import { getWebauthnConfig } from "../_shared/webauthnOrigin.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = (Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY"))!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RP_NAME = Deno.env.get("WEBAUTHN_RP_NAME") ?? "DuoSpace";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return json({ error: "Unauthorized" }, 401);
    }
    const supa = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: uErr } = await supa.auth.getUser();
    if (uErr || !user) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    const { data: existing } = await admin
      .from("webauthn_credentials")
      .select("credential_id, transports")
      .eq("user_id", user.id);

    const { rpID } = getWebauthnConfig(req);
    const options = await generateRegistrationOptions({
      rpID,
      rpName: RP_NAME,
      userID: new TextEncoder().encode(user.id),
      userName: user.email ?? user.id,
      userDisplayName: (user.user_metadata?.full_name as string) ?? user.email ?? "DuoSpace user",
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "preferred",
      },
      excludeCredentials: (existing ?? []).map((c) => ({
        id: c.credential_id,
        transports: c.transports as AuthenticatorTransport[] | undefined,
      })),
    });

    const expires = new Date(Date.now() + 5 * 60_000).toISOString();
    const { error: insErr } = await admin.from("webauthn_challenges").insert({
      user_id: user.id,
      challenge: options.challenge,
      kind: "registration",
      expires_at: expires,
    });
    if (insErr) throw insErr;

    return json(options, 200);
  } catch (e) {
    console.error("[webauthn-register-options]", e);
    return json({ error: e instanceof Error ? e.message : "Internal error" }, 500);
  }
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

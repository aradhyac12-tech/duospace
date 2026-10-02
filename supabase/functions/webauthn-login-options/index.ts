// Edge function: webauthn-login-options
// Public. Given an optional email, returns PublicKeyCredentialRequestOptionsJSON.
// If email is omitted, uses a discoverable-credential (usernameless) flow —
// the browser lets the user pick which passkey to use.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { generateAuthenticationOptions } from "npm:@simplewebauthn/server@13.3.0";
import { corsHeaders } from "../_shared/cors.ts";
import { consumeRateLimit } from "../_shared/rateLimit.ts";
import { getWebauthnConfig } from "../_shared/webauthnOrigin.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const allowed = await consumeRateLimit(ip, "webauthn-login-options", 20, 60);
    if (!allowed) return json({ error: "Too many attempts" }, 429);

    const body = await req.json().catch(() => ({})) as { email?: string };
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    let userId: string | null = null;
    let allowCredentials: { id: string; transports?: AuthenticatorTransport[] }[] = [];

    if (body.email && typeof body.email === "string") {
      // Look up user by email. auth.admin.listUsers is expensive but adequate.
      const email = body.email.trim().toLowerCase();
      const { data: users } = await admin.auth.admin.listUsers({
        page: 1, perPage: 200,
      });
      const match = users?.users.find((u) => u.email?.toLowerCase() === email);
      if (match) {
        userId = match.id;
        const { data: creds } = await admin
          .from("webauthn_credentials")
          .select("credential_id, transports")
          .eq("user_id", match.id);
        allowCredentials = (creds ?? []).map((c) => ({
          id: c.credential_id,
          transports: c.transports as AuthenticatorTransport[] | undefined,
        }));
      }
    }

    const { rpID } = getWebauthnConfig(req);
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: "preferred",
      allowCredentials: allowCredentials.length ? allowCredentials : undefined,
    });

    const expires = new Date(Date.now() + 5 * 60_000).toISOString();
    const { error: insErr } = await admin.from("webauthn_challenges").insert({
      user_id: userId,
      challenge: options.challenge,
      kind: "authentication",
      expires_at: expires,
    });
    if (insErr) throw insErr;

    return json(options, 200);
  } catch (e) {
    console.error("[webauthn-login-options]", e);
    return json({ error: e instanceof Error ? e.message : "Internal error" }, 500);
  }
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

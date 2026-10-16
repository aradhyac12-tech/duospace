// Edge function: webauthn-login-verify
// Public. Verifies the authentication response, then mints a Supabase session
// via admin.generateLink({type:'magiclink'}) + verifyOtp — same pattern as
// redeem-qr-token. Returns { access_token, refresh_token }.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyAuthenticationResponse } from "npm:@simplewebauthn/server@13.3.0";
import { corsHeaders } from "../_shared/cors.ts";
import { consumeRateLimit } from "../_shared/rateLimit.ts";
import { getWebauthnConfig } from "../_shared/webauthnOrigin.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = (Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY"))!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const allowed = await consumeRateLimit(ip, "webauthn-login-verify", 10, 60);
    if (!allowed) return json({ error: "Too many attempts" }, 429);

    const body = await req.json().catch(() => null) as { response?: {
      id?: string; rawId?: string; response?: unknown; type?: string;
    } } | null;
    if (!body?.response?.id) return json({ error: "Missing response" }, 400);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    const credId = body.response.id;
    const { data: cred } = await admin
      .from("webauthn_credentials")
      .select("id, user_id, credential_id, public_key, counter, transports")
      .eq("credential_id", credId)
      .maybeSingle();
    if (!cred) return json({ error: "Unknown credential" }, 404);

    // Find newest unconsumed challenge for this user (or usernameless).
    const { data: chal } = await admin
      .from("webauthn_challenges")
      .select("id, challenge, expires_at, user_id")
      .eq("kind", "authentication")
      .is("consumed_at", null)
      .or(`user_id.eq.${cred.user_id},user_id.is.null`)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!chal) return json({ error: "No pending challenge" }, 400);
    if (new Date(chal.expires_at).getTime() < Date.now()) {
      return json({ error: "Challenge expired" }, 400);
    }

    const { rpID, origins } = getWebauthnConfig(req);
    const verification = await verifyAuthenticationResponse({
      response: body.response as never,
      expectedChallenge: chal.challenge,
      expectedOrigin: origins,
      expectedRPID: rpID,
      credential: {
        id: cred.credential_id,
        publicKey: base64UrlDecode(cred.public_key),
        counter: Number(cred.counter),
        transports: cred.transports as AuthenticatorTransport[] | undefined,
      },
      requireUserVerification: false,
    });

    if (!verification.verified) return json({ error: "Verification failed" }, 400);

    await admin.from("webauthn_credentials")
      .update({
        counter: verification.authenticationInfo.newCounter,
        last_used_at: new Date().toISOString(),
      })
      .eq("id", cred.id);

    await admin.from("webauthn_challenges")
      .update({ consumed_at: new Date().toISOString() })
      .eq("id", chal.id);

    // Mint session for cred.user_id.
    const { data: userRes, error: uErr } = await admin.auth.admin
      .getUserById(cred.user_id);
    if (uErr || !userRes?.user?.email) return json({ error: "User missing email" }, 500);

    const { data: linkData, error: linkErr } = await admin.auth.admin
      .generateLink({ type: "magiclink", email: userRes.user.email });
    if (linkErr || !linkData?.properties?.hashed_token) {
      console.error("[webauthn-login-verify] generateLink", linkErr?.message);
      return json({ error: "Session mint failed" }, 500);
    }

    const anon = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: v, error: vErr } = await anon.auth.verifyOtp({
      token_hash: linkData.properties.hashed_token,
      type: "magiclink",
    });
    if (vErr || !v?.session) {
      console.error("[webauthn-login-verify] verifyOtp", vErr?.message);
      return json({ error: "Session mint failed" }, 500);
    }

    return json({
      access_token: v.session.access_token,
      refresh_token: v.session.refresh_token,
      expires_at: v.session.expires_at,
    }, 200);
  } catch (e) {
    console.error("[webauthn-login-verify]", e);
    return json({ error: e instanceof Error ? e.message : "Internal error" }, 500);
  }
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
function base64UrlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 2 ? "==" : s.length % 4 === 3 ? "=" : "";
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

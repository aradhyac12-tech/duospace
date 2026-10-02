// Edge Function: redeem-qr-token
// Called by an UNAUTHENTICATED device (Device B) that just scanned a QR. Given
// the raw pairing token, this function:
//   1) Hashes the token and looks it up in qr_pairing_tokens.
//   2) Checks it exists, hasn't expired, and hasn't already been redeemed.
//   3) Atomically marks it redeemed (single-use).
//   4) Uses the service role to issue a fresh magic-link for the owning user,
//      then immediately verifies the underlying OTP to mint a session.
//   5) Returns { access_token, refresh_token } for the client to install via
//      supabase.auth.setSession().
//
// Token kinds (see qr_pairing_tokens.token_type):
//   device_pairing — mints a session for the token owner (sign in on a new device).
//   signup_invite  — issued by a SIGNED-IN partner A.
//        scanner signed in  → A and the scanner are linked right here, atomically
//                             (kind: "partner_linked"). This is what the in-app
//                             "Scan partner's QR" button does.
//        scanner signed out → the scanner is sent to Sign Up; A is remembered in
//                             pending_partner_for so the scanner can claim the
//                             link with claim_qr_partner_link() once it has a
//                             session (kind: "signup_invite").
//   anon_signup    — issued by a signed-OUT device that is about to sign up.
//        scanner signed in  → scanner recorded in pending_partner_for; the
//                             issuer claims the link after it has an account.
//
// The QR token is NEVER a JWT. The client-side session tokens are minted
// server-side, on demand, only for a valid, unredeemed, unexpired pairing row.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { consumeRateLimit } from "../_shared/rateLimit.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = (Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY"))!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Returns a human-readable reason the two accounts can't be linked, or null. */
async function linkRefusalReason(
  admin: ReturnType<typeof createClient>,
  a: string,
  b: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("profiles")
    .select("user_id, partner_id")
    .in("user_id", [a, b]);
  if (error) return "Couldn't check your accounts. Please try again.";
  const rows = (data ?? []) as { user_id: string; partner_id: string | null }[];
  const pa = rows.find((r) => r.user_id === a);
  const pb = rows.find((r) => r.user_id === b);
  if (!pa || !pb) return "One of the profiles isn't set up yet. Finish setup and try again.";
  if (pa.partner_id === b && pb.partner_id === a) return null; // already each other's partner — idempotent
  if ((pa.partner_id && pa.partner_id !== b) || (pb.partner_id && pb.partner_id !== a)) {
    return "One of you is already linked with someone else. Unlink first, then try again.";
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? "unknown";

  try {
    // IP-scoped rate limit to shut down brute-force redemption: 8 attempts / 60s.
    const allowed = await consumeRateLimit(ip, "qr-redeem", 8, 60);
    if (!allowed) {
      return new Response(
        JSON.stringify({ error: "Too many redemption attempts." }),
        {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const { token } = (await req.json().catch(() => ({}))) as {
      token?: string;
    };
    if (!token || typeof token !== "string" || token.length < 16 || token.length > 128) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const tokenHash = await sha256Hex(token);
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    // The caller may optionally be authenticated (Device B is already signed in
    // and scanning to link with a new partner). If so, we grab their user_id
    // and use it for the anon_signup partner-link flow.
    let scannerUserId: string | null = null;
    const authHeader = req.headers.get("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      try {
        const { data } = await admin.auth.getUser(authHeader.replace("Bearer ", ""));
        scannerUserId = data?.user?.id ?? null;
      } catch { /* treat as anon */ }
    }

    // Read-only look at the token BEFORE consuming it, so a link that is
    // going to be refused (own QR, someone already paired) does not burn the
    // single-use token — the QR stays scannable once the problem is fixed.
    const { data: peek } = await admin
      .from("qr_pairing_tokens")
      .select("user_id, token_type")
      .eq("token_hash", tokenHash)
      .is("redeemed_at", null)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    const peekType = (peek as { token_type?: string } | null)?.token_type ?? null;
    const peekOwner = (peek as { user_id?: string | null } | null)?.user_id ?? null;

    if (peekType === "signup_invite" && scannerUserId && peekOwner) {
      if (peekOwner === scannerUserId) {
        return json({ error: "That's your own QR code. Scan the one on your partner's phone." }, 400);
      }
      const refusal = await linkRefusalReason(admin, scannerUserId, peekOwner);
      if (refusal) return json({ error: refusal }, 409);
    }

    // Who should the CLAIMING device end up linked to? Only meaningful for the
    // two "link later" combinations described in the header comment.
    let pendingPartnerFor: string | null = null;
    if (peekType === "anon_signup" && scannerUserId) pendingPartnerFor = scannerUserId;
    if (peekType === "signup_invite" && !scannerUserId) pendingPartnerFor = peekOwner;

    // Atomic single-use redemption.
    const { data: redeemedRow, error: updErr } = await admin
      .from("qr_pairing_tokens")
      .update({
        redeemed_at: new Date().toISOString(),
        redeemed_ip: ip,
        redeemed_ua: req.headers.get("user-agent") ?? null,
        redeemed_by_user_id: scannerUserId,
        pending_partner_for: pendingPartnerFor,
      })
      .eq("token_hash", tokenHash)
      .is("redeemed_at", null)
      .gt("expires_at", new Date().toISOString())
      .select("user_id, token_type")
      .maybeSingle();

    if (updErr) {
      console.error("[redeem-qr-token] update error:", updErr.message);
      return new Response(JSON.stringify({ error: "Redemption failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!redeemedRow) {
      return new Response(
        JSON.stringify({ error: "Token invalid, expired, or already used" }),
        {
          status: 410,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const tokenType = (redeemedRow as { token_type?: string }).token_type ?? "device_pairing";
    if (tokenType === "signup_invite") {
      // Scanner is signed in → this is the "link with my partner" case. Do the
      // link now, server-side; the old code returned here without linking
      // anyone while the app showed a success message.
      if (scannerUserId && redeemedRow.user_id) {
        const inviterId = redeemedRow.user_id as string;
        const { error: linkErr } = await admin.rpc("link_partners", { _a: scannerUserId, _b: inviterId });
        if (linkErr) {
          console.error("[redeem-qr-token] link_partners error:", linkErr.message);
          // Give the QR back so it can be scanned again after the cause is fixed.
          await admin.from("qr_pairing_tokens").update({
            redeemed_at: null,
            redeemed_ip: null,
            redeemed_ua: null,
            redeemed_by_user_id: null,
            pending_partner_for: null,
          }).eq("token_hash", tokenHash);
          const already = (linkErr.message ?? "").includes("ALREADY_LINKED");
          return json(
            { error: already
                ? "One of you is already linked with someone else. Unlink first, then try again."
                : "Couldn't link you two. Please try again." },
            already ? 409 : 500,
          );
        }
        // Best-effort marker so the QR-showing device can tell "linked" from
        // "just scanned". (Column added by 20260920130000_qr_partner_link_fix.sql;
        // an error here must never undo a link that already succeeded.)
        await admin.from("qr_pairing_tokens").update({ claimed_by_user_id: scannerUserId })
          .eq("token_hash", tokenHash);
        let partnerName: string | null = null;
        try {
          const { data: prof } = await admin.from("profiles").select("display_name")
            .eq("user_id", inviterId).maybeSingle();
          partnerName = (prof as { display_name?: string | null } | null)?.display_name ?? null;
        } catch { /* cosmetic only */ }
        return json({ kind: "partner_linked", partner_id: inviterId, partner_name: partnerName }, 200);
      }
      // Scanner is signed out → they must sign up first; they claim the link
      // afterwards with the raw token they scanned (claim_qr_partner_link).
      return new Response(
        JSON.stringify({ kind: "signup_invite", inviter_id: redeemedRow.user_id }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (tokenType === "anon_signup") {
      // Issued by an unauthed device. If the scanner is authed, they'll be
      // auto-linked as partner once the issuing user finishes signup. If the
      // scanner is anon too, both devices must complete signup separately —
      // return early either way; no session is minted here.
      return new Response(
        JSON.stringify({
          kind: "anon_signup",
          linked_partner: scannerUserId ? true : false,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }


    // Look up the user's email via admin API. auth.users isn't exposed to the
    // Data API, so we use the admin auth API.
    const { data: userRes, error: userErr } = await admin.auth.admin
      .getUserById(redeemedRow.user_id);
    if (userErr || !userRes?.user?.email) {
      console.error(
        "[redeem-qr-token] getUserById error:",
        userErr?.message,
      );
      return new Response(JSON.stringify({ error: "User not found" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const email = userRes.user.email;

    // Mint a fresh magic-link (hashed OTP) for this user and immediately
    // verify it to receive a real access/refresh token pair. The generated
    // link is NOT sent by email — we consume it in-process.
    const { data: linkData, error: linkErr } = await admin.auth.admin
      .generateLink({ type: "magiclink", email });
    if (linkErr || !linkData?.properties?.hashed_token) {
      console.error(
        "[redeem-qr-token] generateLink error:",
        linkErr?.message,
      );
      return new Response(JSON.stringify({ error: "Session mint failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const anon = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: verifyData, error: verifyErr } = await anon.auth.verifyOtp({
      token_hash: linkData.properties.hashed_token,
      type: "magiclink",
    });
    if (verifyErr || !verifyData?.session) {
      console.error(
        "[redeem-qr-token] verifyOtp error:",
        verifyErr?.message,
      );
      return new Response(JSON.stringify({ error: "Session mint failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        kind: "session",
        access_token: verifyData.session.access_token,
        refresh_token: verifyData.session.refresh_token,
        expires_at: verifyData.session.expires_at,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (e) {
    console.error("[redeem-qr-token] exception:", e);
    return new Response(JSON.stringify({ error: "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

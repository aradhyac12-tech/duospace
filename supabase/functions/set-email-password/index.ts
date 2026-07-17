// Edge function: set-email-password
// Auth: signed-in user (typically one who signed up via QR and has no email
// yet). Two-step OTP:
//   step 'request'  { email }               → sends 6-digit OTP via Resend.
//   step 'verify'   { email, otp, password }→ updates user's email + password.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { consumeRateLimit } from "../_shared/rateLimit.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = (Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY"))!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const EMAIL_FROM = Deno.env.get("EMAIL_FROM") ?? "DuoSpace <onboarding@resend.dev>";

async function sha256Hex(input: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

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

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    const body = await req.json().catch(() => null) as {
      step?: "request" | "verify"; email?: string; otp?: string; password?: string;
    } | null;
    if (!body?.step) return json({ error: "Missing step" }, 400);

    const allowed = await consumeRateLimit(user.id, "set-email-password", 6, 60);
    if (!allowed) return json({ error: "Too many attempts" }, 429);

    // ── request ────────────────────────────────────────────────────────
    if (body.step === "request") {
      const email = (body.email ?? "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Invalid email" }, 400);
      if (!RESEND_API_KEY) return json({ error: "Email sender not configured" }, 500);

      const otp = String(Math.floor(100000 + Math.random() * 900000));
      const hash = await sha256Hex(otp);
      const expires = new Date(Date.now() + 10 * 60_000).toISOString();

      // Invalidate previous unconsumed rows for this user.
      await admin.from("email_change_otps")
        .update({ consumed_at: new Date().toISOString() })
        .eq("user_id", user.id).is("consumed_at", null);

      const { error: insErr } = await admin.from("email_change_otps").insert({
        user_id: user.id, email, otp_hash: hash, expires_at: expires,
      });
      if (insErr) throw insErr;

      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: EMAIL_FROM, to: [email],
          subject: `Your DuoSpace verification code: ${otp}`,
          html: `<div style="font-family:system-ui,sans-serif;padding:24px">
            <h2 style="margin:0 0 12px">Confirm your email</h2>
            <p>Enter this code in DuoSpace to add email + password sign-in to your account:</p>
            <div style="font-size:32px;font-weight:700;letter-spacing:6px;margin:16px 0">${otp}</div>
            <p style="color:#666;font-size:12px">This code expires in 10 minutes.</p>
          </div>`,
        }),
      });
      if (!resp.ok) {
        const txt = await resp.text();
        console.error("[set-email-password] resend error", resp.status, txt);
        return json({ error: "Failed to send email" }, 502);
      }
      return json({ ok: true }, 200);
    }

    // ── verify ─────────────────────────────────────────────────────────
    if (body.step === "verify") {
      const email = (body.email ?? "").trim().toLowerCase();
      const otp = (body.otp ?? "").trim();
      const password = body.password ?? "";
      if (!/^\d{6}$/.test(otp)) return json({ error: "Invalid code" }, 400);
      if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
        return json({ error: "Password must be at least 8 characters with letters and numbers" }, 400);
      }

      const { data: row } = await admin
        .from("email_change_otps")
        .select("id, otp_hash, attempts, expires_at, email")
        .eq("user_id", user.id).eq("email", email)
        .is("consumed_at", null)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (!row) return json({ error: "No pending code" }, 400);
      if (new Date(row.expires_at).getTime() < Date.now()) {
        return json({ error: "Code expired" }, 400);
      }
      if (row.attempts >= 5) return json({ error: "Too many attempts" }, 429);

      const hash = await sha256Hex(otp);
      if (hash !== row.otp_hash) {
        await admin.from("email_change_otps")
          .update({ attempts: row.attempts + 1 }).eq("id", row.id);
        return json({ error: "Incorrect code" }, 400);
      }

      const { error: updErr } = await admin.auth.admin.updateUserById(user.id, {
        email, password, email_confirm: true,
      });
      if (updErr) {
        console.error("[set-email-password] updateUser", updErr.message);
        return json({ error: updErr.message }, 400);
      }

      await admin.from("email_change_otps")
        .update({ consumed_at: new Date().toISOString() })
        .eq("id", row.id);

      return json({ ok: true }, 200);
    }

    return json({ error: "Unknown step" }, 400);
  } catch (e) {
    console.error("[set-email-password]", e);
    return json({ error: e instanceof Error ? e.message : "Internal error" }, 500);
  }
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

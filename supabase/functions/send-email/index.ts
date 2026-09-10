// AUDIT FIX #12: Require authenticated caller.
// FIX AUDIT #6: Persistent (DB-backed) rate limit — survives cold starts.
// FIX AUDIT #11: Strict Zod validation + HTML sanitization on subject/html.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders } from "../_shared/cors.ts";
import { consumeRateLimit } from "../_shared/rateLimit.ts";

// Strip <script>/<iframe>/event handlers from any HTML the caller supplies.
function sanitizeHtml(html: string): string {
  return html
    .replace(/<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi, "")
    .replace(/<\s*iframe[\s\S]*?<\s*\/\s*iframe\s*>/gi, "")
    .replace(/<\s*object[\s\S]*?<\s*\/\s*object\s*>/gi, "")
    .replace(/<\s*embed[\s\S]*?<\s*\/\s*embed\s*>/gi, "")
    .replace(/ on\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/ on\w+\s*=\s*'[^']*'/gi, "")
    .replace(/javascript:/gi, "");
}

function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const EmailSchema = z.object({
  to: z.string().trim().email().max(254),
  subject: z.string().trim().min(1).max(200),
  html: z.string().max(50_000).optional(),
  type: z.string().max(50).optional(),
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
    return new Response(JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: jsonHeaders });
  }

  // 3 emails per 5 minutes per user, persisted in DB.
  const allowed = await consumeRateLimit(user.id, "send-email", 3, 300);
  if (!allowed) {
    return new Response(
      JSON.stringify({ error: "Rate limit: max 3 emails per 5 minutes." }),
      { status: 429, headers: { ...jsonHeaders, "Retry-After": "300" } },
    );
  }

  try {
    const RESEND_API_KEY = Deno.env.get("Resend_api_key");
    if (!RESEND_API_KEY) {
      return new Response(JSON.stringify({ error: "Resend_api_key not configured" }),
        { status: 500, headers: jsonHeaders });
    }

    const raw = await req.json();
    const parsed = EmailSchema.safeParse(raw);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: "Invalid input", issues: parsed.error.issues }),
        { status: 400, headers: jsonHeaders },
      );
    }
    const { to, subject, html, type } = parsed.data;
    const safeSubject = escapeText(subject);
    const safeHtml = html ? sanitizeHtml(html) : getDefaultTemplate(type ?? "", safeSubject);

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // Was hardcoded to "noreply@resend.dev" — Resend's own shared
        // testing domain, which by design can only deliver to the email
        // address on the Resend account itself (every other recipient gets
        // a 403). That silently broke this for every real user. EMAIL_FROM
        // matches the same env var / fallback convention already used in
        // set-email-password/index.ts — once a domain is verified in
        // Resend, set EMAIL_FROM to an address on it (e.g.
        // "DuoSpace <noreply@yourdomain.com>") and every email sent through
        // this function picks it up with no further code changes.
        from: Deno.env.get("EMAIL_FROM") ?? "DuoSpace <onboarding@resend.dev>",
        to: [to],
        subject,
        html: safeHtml,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      console.error("Resend error:", data);
      return new Response(JSON.stringify({ error: data.message || "Failed to send email" }),
        { status: res.status, headers: jsonHeaders });
    }
    return new Response(JSON.stringify({ success: true, id: data.id }),
      { headers: jsonHeaders });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("Email error:", msg);
    return new Response(JSON.stringify({ error: msg }),
      { status: 500, headers: jsonHeaders });
  }
});

function getDefaultTemplate(_type: string, safeSubject: string): string {
  return `
    <!DOCTYPE html>
    <html>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f0ec; padding: 40px 20px;">
      <div style="max-width: 400px; margin: 0 auto; background: white; border-radius: 16px; padding: 32px; text-align: center;">
        <h1 style="font-size: 24px; font-weight: 600; color: #2c2c2c; margin-bottom: 8px;">DuoSpace</h1>
        <p style="font-size: 14px; color: #737373; margin-bottom: 24px;">${safeSubject}</p>
        <p style="font-size: 13px; color: #a3a3a3; margin-top: 32px;">End-to-end encrypted • Your data stays yours</p>
      </div>
    </body>
    </html>
  `;
}

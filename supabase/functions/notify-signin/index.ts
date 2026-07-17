// notify-signin: emails the user only when a sign-in comes from a device
// fingerprint we haven't recorded before (Instagram-style).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders } from "../_shared/cors.ts";
import { consumeRateLimit } from "../_shared/rateLimit.ts";

const BodySchema = z.object({
  fingerprint: z.string().trim().min(8).max(128),
  userAgent: z.string().max(500).optional(),
  platform: z.string().max(100).optional(),
  timezone: z.string().max(100).optional(),
});

function labelFrom(ua = "", platform = "") {
  const browser =
    /Firefox\//.test(ua) ? "Firefox" :
    /Edg\//.test(ua) ? "Edge" :
    /Chrome\//.test(ua) ? "Chrome" :
    /Safari\//.test(ua) ? "Safari" : "Browser";
  const os =
    /iPhone|iPad|iOS/i.test(ua) ? "iOS" :
    /Android/i.test(ua) ? "Android" :
    /Mac OS X/i.test(ua) ? "macOS" :
    /Windows/i.test(ua) ? "Windows" :
    /Linux/i.test(ua) ? "Linux" : (platform || "device");
  return `${browser} on ${os}`;
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

  const authHeader = req.headers.get("Authorization") ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = (Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY"))!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user?.email) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: jsonHeaders });
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: "Invalid input" }), { status: 400, headers: jsonHeaders });
  }
  const { fingerprint, userAgent = "", platform = "", timezone = "" } = parsed.data;

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // Look up existing device row.
  const { data: existing } = await admin
    .from("known_devices")
    .select("id")
    .eq("user_id", user.id)
    .eq("fingerprint", fingerprint)
    .maybeSingle();

  if (existing) {
    await admin.from("known_devices")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", existing.id);
    return new Response(JSON.stringify({ known: true }), { headers: jsonHeaders });
  }

  // New device — insert row, rate-limit, then email.
  const label = labelFrom(userAgent, platform);
  await admin.from("known_devices").insert({
    user_id: user.id,
    fingerprint,
    label,
    user_agent: userAgent.slice(0, 500),
  });

  const allowed = await consumeRateLimit(user.id, "notify-signin", 3, 3600);
  if (!allowed) {
    return new Response(JSON.stringify({ known: false, emailed: false, reason: "rate_limited" }), { headers: jsonHeaders });
  }

  const country = req.headers.get("cf-ipcountry") || req.headers.get("x-vercel-ip-country") || "";
  const when = new Date().toUTCString();
  const subject = "New sign-in to your DuoSpace account";
  const html = `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f0ec;padding:40px 20px;">
  <div style="max-width:440px;margin:0 auto;background:#fff;border-radius:16px;padding:28px;">
    <h1 style="font-size:20px;font-weight:600;color:#2c2c2c;margin:0 0 12px;">New device signed in</h1>
    <p style="color:#525252;font-size:14px;line-height:1.5;margin:0 0 16px;">
      We detected a sign-in to your DuoSpace account from a device we haven't seen before.
    </p>
    <div style="background:#f5f5f4;border-radius:12px;padding:14px 16px;font-size:13px;color:#404040;line-height:1.7;">
      <div><strong>Device:</strong> ${esc(label)}</div>
      <div><strong>When:</strong> ${esc(when)}</div>
      ${timezone ? `<div><strong>Timezone:</strong> ${esc(timezone)}</div>` : ""}
      ${country ? `<div><strong>Country:</strong> ${esc(country)}</div>` : ""}
    </div>
    <p style="color:#525252;font-size:14px;line-height:1.5;margin:20px 0 0;">
      If this was you, no action needed. If not, change your password and remove the device from
      <em>Settings → Recent devices</em>.
    </p>
    <p style="font-size:12px;color:#a3a3a3;margin-top:24px;">DuoSpace • End-to-end encrypted</p>
  </div>
</body></html>`;

  try {
    await fetch(`${supabaseUrl}/functions/v1/send-email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body: JSON.stringify({ to: user.email, subject, html, type: "signin_alert" }),
    });
  } catch (e) {
    console.error("notify-signin: email failed", e);
  }

  return new Response(JSON.stringify({ known: false, emailed: true }), { headers: jsonHeaders });
});

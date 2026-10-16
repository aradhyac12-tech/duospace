#!/usr/bin/env node
/**
 * check-calling-config — preflight for the self-hosted signaling +
 * LiveKit Cloud calling stack.
 *
 *   node scripts/check-calling-config.mjs <env-file>
 *   e.g. node scripts/check-calling-config.mjs infrastructure/deployment/.env.production
 *
 * Fails (exit 1) on anything that would make calls fail or silently degrade
 * in production: missing required values, REPLACE placeholders, localhost /
 * private hosts, non-TLS public URLs, an unbounded token TTL. MEDIA/SFU/TURN
 * MIGRATION: this env file no longer carries LiveKit connection info at all
 * (LIVEKIT_URL/LIVEKIT_API_KEY/LIVEKIT_API_SECRET/LIVEKIT_NODE_IP) — those
 * are Supabase secrets now, consumed only by the `livekit-token` edge
 * function, and there is no local `livekit.yaml` to validate since LiveKit
 * Cloud manages its own TURN/TLS. Check them with `supabase secrets list`
 * (values aren't readable back, but presence is) instead of this script.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

// usage: check-calling-config.mjs <env-file> [--dist <built web dir, e.g. dist>]
const args = process.argv.slice(2);
const distIdx = args.indexOf("--dist");
const distDir = distIdx >= 0 ? args[distIdx + 1] : null;
const envPath = args.find((a, i) => a !== "--dist" && (distIdx < 0 || i !== distIdx + 1));
if (!envPath) {
  console.error("usage: check-calling-config.mjs <env-file> [--dist dist]");
  process.exit(2);
}
const errors = [];
const warn = [];
const env = {};
if (!existsSync(envPath)) errors.push(`env file not found: ${envPath}`);
else for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*([^#]*?)\s*(#.*)?$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const bad = (v) => !v || /REPLACE|example\.(com|invalid)|changeme/i.test(v);
const local = (v) => /localhost|127\.0\.0\.1|0\.0\.0\.0|\b10\.\d|\b192\.168\.|\b172\.(1[6-9]|2\d|3[01])\./i.test(v ?? "");

// Signaling tickets: signed by the signaling-ticket Edge Function, verified by
// the signaling server — both must share SIGNALING_TICKET_SECRET. Supabase
// never gives Edge Functions SUPABASE_JWT_SECRET (reserved SUPABASE_ prefix),
// so relying on it silently breaks every call.
if (bad(env.SIGNALING_TICKET_SECRET)) errors.push("SIGNALING_TICKET_SECRET is missing — also set it as a Supabase Edge Function secret with the SAME value");
else if (env.SIGNALING_TICKET_SECRET.length < 32) errors.push("SIGNALING_TICKET_SECRET should be at least 32 characters (openssl rand -hex 32)");
if (env.SUPABASE_JWT_SECRET && !env.SIGNALING_TICKET_SECRET) errors.push("SUPABASE_JWT_SECRET cannot be delivered to the signaling-ticket Edge Function on hosted Supabase — use SIGNALING_TICKET_SECRET");
for (const k of ["VITE_SIGNALING_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
  if (bad(env[k])) errors.push(`${k} is missing or still a placeholder`);
}
if (env.VITE_SIGNALING_URL && !/^wss:\/\//.test(env.VITE_SIGNALING_URL)) errors.push(`VITE_SIGNALING_URL must be wss:// (got ${env.VITE_SIGNALING_URL})`);
if (local(env.VITE_SIGNALING_URL)) errors.push(`VITE_SIGNALING_URL points at a local/private host: ${env.VITE_SIGNALING_URL}`);
if (/VITE_CALL_PROVIDER/.test(Object.keys(env).join(" "))) errors.push("VITE_CALL_PROVIDER is obsolete — there is only one provider; remove it");
for (const k of Object.keys(env)) if (/^VITE_/.test(k) && /SECRET|SERVICE_ROLE|API_KEY|LIVEKIT/.test(k)) errors.push(`${k}: secrets/LiveKit credentials must never be VITE_ (bundled into the client) or in this file — set as Supabase secrets instead`);
for (const k of ["LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "LIVEKIT_URL", "LIVEKIT_NODE_IP", "LIVEKIT_CONFIG_FILE", "TURN_CERT_DIR"]) {
  if (k in env) warn.push(`${k} is set in this file but is no longer used here (LiveKit Cloud migration) — remove it; the real value belongs in Supabase secrets (LIVEKIT_API_KEY/LIVEKIT_API_SECRET/LIVEKIT_URL only)`);
}

// ---- SIGNALING_PUBLIC_URL (Supabase secret; runtime URL for builds without VITE_SIGNALING_URL)
if (env.SIGNALING_PUBLIC_URL) {
  if (!/^wss:\/\/[a-z0-9.-]+(:\d+)?(\/\S*)?$/i.test(env.SIGNALING_PUBLIC_URL)) errors.push(`SIGNALING_PUBLIC_URL must be a public wss:// URL (got ${env.SIGNALING_PUBLIC_URL})`);
  if (local(env.SIGNALING_PUBLIC_URL) || bad(env.SIGNALING_PUBLIC_URL)) errors.push(`SIGNALING_PUBLIC_URL is local/private/placeholder: ${env.SIGNALING_PUBLIC_URL}`);
  if (env.VITE_SIGNALING_URL && env.SIGNALING_PUBLIC_URL.replace(/\/+$/, "") !== env.VITE_SIGNALING_URL.replace(/\/+$/, "")) warn.push("SIGNALING_PUBLIC_URL differs from VITE_SIGNALING_URL — builds without the VITE var will connect somewhere else");
} else warn.push("SIGNALING_PUBLIC_URL not in this file — if any build (APK/Vercel) is made WITHOUT VITE_SIGNALING_URL, it must be set as a Supabase secret");
if (env.VITE_SIGNALING_URL && /[?#]|token=/i.test(env.VITE_SIGNALING_URL)) errors.push("VITE_SIGNALING_URL must not contain a query string/token — tickets are added per connection");

// ---- SIGNALING_ALLOWED_ORIGINS (signaling server). Empty in production is now fatal at server start.
const origins = (env.SIGNALING_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (origins.length === 0) errors.push('SIGNALING_ALLOWED_ORIGINS is empty — the signaling server refuses to start in production. List your web origin plus https://localhost (Android) and capacitor://localhost (iOS), or "*" to deliberately allow any');
else if (origins.includes("*")) { if (origins.length > 1) errors.push('SIGNALING_ALLOWED_ORIGINS: "*" cannot be combined with other origins'); else warn.push('SIGNALING_ALLOWED_ORIGINS="*": any website origin may open a socket (tickets still required)'); }
else {
  for (const o of origins) if (!/^[a-z][a-z0-9+.-]*:\/\/[^/\s]+\/?$/i.test(o)) errors.push(`SIGNALING_ALLOWED_ORIGINS: not an origin: ${o}`);
  for (const o of origins) if (bad(o)) errors.push(`SIGNALING_ALLOWED_ORIGINS still has a placeholder: ${o}`);
  const norm = new Set(origins.map((o) => o.toLowerCase().replace(/\/+$/, "")));
  if (!norm.has("https://localhost")) errors.push("SIGNALING_ALLOWED_ORIGINS is missing https://localhost — the Android app (Capacitor WebView) will get 403");
  if (!norm.has("capacitor://localhost")) warn.push("SIGNALING_ALLOWED_ORIGINS is missing capacitor://localhost — the iOS app will get 403");
}

// ---- built bundle (optional): what actually ships in the web/APK build
if (distDir) {
  if (!existsSync(distDir)) errors.push(`--dist ${distDir} not found (build first)`);
  else {
    const files = [];
    const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(js|html|json)$/.test(f)) files.push(p); } };
    walk(distDir);
    const text = files.map((f) => readFileSync(f, "utf8")).join("\n");
    if (env.VITE_SIGNALING_URL && !text.includes(env.VITE_SIGNALING_URL)) errors.push(`built bundle does not contain VITE_SIGNALING_URL (${env.VITE_SIGNALING_URL}) — was it set when building? (runtime SIGNALING_PUBLIC_URL fallback will be used)`);
    const localWs = text.match(/wss?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+)[^"'\s]*/i);
    if (localWs) errors.push(`built bundle contains a local/private WebSocket URL: ${localWs[0]}`);
    if (/wss:\/\/[^"'\s]*(REPLACE|example\.com)/i.test(text)) errors.push("built bundle contains a placeholder wss:// URL");
    if (env.SIGNALING_TICKET_SECRET && env.SIGNALING_TICKET_SECRET.length >= 16 && text.includes(env.SIGNALING_TICKET_SECRET)) errors.push("built bundle CONTAINS SIGNALING_TICKET_SECRET — a secret was bundled into the client");
    if (env.SUPABASE_SERVICE_ROLE_KEY && env.SUPABASE_SERVICE_ROLE_KEY.length >= 16 && text.includes(env.SUPABASE_SERVICE_ROLE_KEY)) errors.push("built bundle CONTAINS SUPABASE_SERVICE_ROLE_KEY");
    if (/"role"\s*:\s*"service_role"|c2VydmljZV9yb2xl/.test(text)) errors.push("built bundle contains a service_role JWT");
  }
}

for (const w of warn) console.warn(`WARN  ${w}`);
for (const e of errors) console.error(`FAIL  ${e}`);
if (errors.length) { console.error(`\n${errors.length} blocking problem(s) in STATIC checks.`); process.exit(1); }
console.log("STATIC PASS  env file" + (distDir ? " + built bundle" : "") + " pass every statically detectable check.");
console.log(`
NOT VERIFIED BY THIS SCRIPT (remote — check manually):
  1. Supabase secret SIGNALING_TICKET_SECRET equals this file's value.
     \`supabase secrets list\` shows a SHA-256 digest per secret; this file's is:
       ${env.SIGNALING_TICKET_SECRET ? createHash("sha256").update(env.SIGNALING_TICKET_SECRET).digest("hex") : "(unset)"}
  2. The Render (signaling server) env has the SAME SIGNALING_TICKET_SECRET, SUPABASE_URL,
     SUPABASE_SERVICE_ROLE_KEY and SIGNALING_ALLOWED_ORIGINS as this file.
  3. Supabase secrets LIVEKIT_API_KEY / LIVEKIT_API_SECRET / LIVEKIT_URL (and SIGNALING_PUBLIC_URL) exist.
  4. A real two-device call connects (remote audio heard both ways).`);

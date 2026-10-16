#!/usr/bin/env node
/**
 * Phase 3M: fail if an AI provider secret, key-shaped string, or direct provider
 * call can reach the client.
 *
 *   node scripts/check-client-secrets.mjs            # scans dist/ (after `npm run build`) AND src/
 *   node scripts/check-client-secrets.mjs --src-only # source scan only (no build needed)
 *
 * Checks
 *   1. dist/**: no OPENAI_API_KEY / GEMINI_API_KEY / SARVAM_API_KEY names, no key-shaped
 *      strings (sk-..., AIza...), no provider API hostnames.
 *   2. src/**: no VITE_* variable whose name mentions a provider/secret, no provider hostnames
 *      (provider calls may only exist under supabase/functions/).
 * Exit 1 on any finding. Prints file + rule only, never the matched secret.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const srcOnly = process.argv.includes("--src-only");
const root = process.cwd();
const findings = [];

const NAMES = /(OPENAI|GEMINI|SARVAM)_API_KEY|GOOGLE_AI_KEY|ANTHROPIC_API_KEY/;
const SHAPES = [
  [/sk-(?:proj-)?[A-Za-z0-9_-]{20,}/, "OpenAI-style key"],
  [/AIza[0-9A-Za-z_-]{30,}/, "Google API key"],
];
const HOSTS = /api\.openai\.com|generativelanguage\.googleapis\.com|api\.sarvam\.ai/;
const VITE_SECRET = /VITE_[A-Z0-9_]*(OPENAI|GEMINI|SARVAM|AI_KEY|SECRET|SERVICE_ROLE)[A-Z0-9_]*/;

function* walk(dir, exts) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p, exts);
    else if (exts.has(extname(p))) yield p;
  }
}
function scan(dir, exts, rules) {
  if (!existsSync(dir)) return false;
  for (const f of walk(dir, exts)) {
    const text = readFileSync(f, "utf8");
    for (const [re, label] of rules) if (re.test(text)) findings.push(`${f}: ${label}`);
  }
  return true;
}

const JS = new Set([".js", ".mjs", ".html", ".map"]);
const SRC = new Set([".ts", ".tsx", ".js", ".jsx", ".env"]);
let scannedDist = false;
if (!srcOnly) {
  scannedDist = scan(join(root, "dist"), JS, [
    [NAMES, "provider secret NAME in client bundle"], ...SHAPES, [HOSTS, "provider hostname in client bundle"],
  ]);
  if (!scannedDist) { console.error("dist/ not found. Run `npm run build` first, or pass --src-only."); process.exit(2); }
}
scan(join(root, "src"), SRC, [[VITE_SECRET, "suspicious VITE_ secret variable"], [HOSTS, "provider hostname in client source"], ...SHAPES]);
for (const f of [".env", ".env.example", ".env.production", ".env.staging"]) {
  const p = join(root, f);
  if (existsSync(p) && VITE_SECRET.test(readFileSync(p, "utf8"))) findings.push(`${f}: VITE_ variable names a provider/secret`);
}

if (findings.length) { console.error("FAIL — client secret audit:\n" + findings.map((x) => "  " + x).join("\n")); process.exit(1); }
console.log(`PASS — no provider secrets or direct provider calls found in ${srcOnly ? "src/" : "dist/ and src/"}.`);

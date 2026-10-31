/**
 * Monetization go-live preflight. Pure checks live in `runPreflight` (no I/O,
 * unit-tested); the CLI at the bottom reads files/env and prints a report.
 *
 *   node scripts/monetization-preflight.mjs --target staging|production \
 *        [--client-env .env.production] [--secrets-file secrets.env] [--mode build|dev]
 *
 * --client-env   dotenv file holding the VITE_* values the build will use.
 * --secrets-file dotenv file with the server secrets you set/plan to set via
 *                `supabase secrets set` (nothing is ever sent anywhere, and
 *                secret VALUES are never printed).
 * Exit code 1 when any FAIL. WARN = decide consciously. It cannot see what is
 * deployed on Supabase/Razorpay/Play: it checks inputs and the repo, not live state.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GOOGLE_TEST_PUBLISHER = "3940256099942544";
const WEBHOOK_FUNCTIONS = ["razorpay-webhook", "google-play-rtdn"];
const MONETIZATION_FUNCTIONS = [
  "create-razorpay-order", "verify-razorpay-payment", "razorpay-webhook", "get-billing-account-token",
  "create-razorpay-subscription", "cancel-razorpay-subscription", "verify-google-play-purchase", "google-play-rtdn",
];

export function parseDotenv(text) {
  const out = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const truthy = (v) => v === "true" || v === "1";

/**
 * @param {{target:"staging"|"production", clientEnv:Record<string,string>, secrets:Record<string,string>|null,
 *          repo:{functionDirs:string[], configToml:string, migrations:string[], admobXml:string, adPolicyAllowsPro?:boolean}}} input
 * @returns {{level:"PASS"|"WARN"|"FAIL", id:string, msg:string}[]}
 */
export function runPreflight({ target, clientEnv, secrets, repo }) {
  const r = [];
  const add = (level, id, msg) => r.push({ level, id, msg });
  const env = clientEnv ?? {};

  // ---- client env -----------------------------------------------------------
  const leaked = Object.keys(env).filter((k) => /^VITE_.*(SECRET|SERVICE_ROLE|PRIVATE_KEY|WEBHOOK)/i.test(k));
  if (leaked.length) add("FAIL", "client-secret", `Secret-looking VITE_ vars are bundled into the app: ${leaked.join(", ")}`);
  else add("PASS", "client-secret", "No secret-looking VITE_ variables");

  const rzClient = Object.entries(env).filter(([k, v]) => /RAZORPAY/i.test(k) && /^rzp_(test|live)_/.test(v));
  for (const [k, v] of rzClient) {
    if (target === "staging" && v.startsWith("rzp_live_")) add("FAIL", "client-rzp-key", `${k} is a LIVE Razorpay key in a staging build`);
    if (target === "production" && v.startsWith("rzp_test_")) add("FAIL", "client-rzp-key", `${k} is a TEST Razorpay key in a production build`);
  }

  if (env.VITE_RAZORPAY_ENABLED === undefined) {
    add("WARN", "razorpay-flag", "VITE_RAZORPAY_ENABLED is unset and the code default is TRUE. Set it explicitly (Play builds are still blocked by paymentRouting, web/sideload are not).");
  } else add("PASS", "razorpay-flag", `VITE_RAZORPAY_ENABLED=${env.VITE_RAZORPAY_ENABLED}`);

  if (env.VITE_RAZORPAY_MODE === "subscription") {
    const need = ["create-razorpay-subscription", "cancel-razorpay-subscription"].filter((f) => !repo.functionDirs.includes(f));
    if (need.length) add("FAIL", "rzp-subscription", `Subscription mode is on but function(s) missing in repo: ${need.join(", ")}`);
    else add("WARN", "rzp-subscription", "Subscription mode is on: both subscription functions must be DEPLOYED, Razorpay Subscriptions/UPI AutoPay enabled, and subscription.* webhook events ticked. The paywall may say 'renews' only in this mode.");
  } else if (env.VITE_RAZORPAY_MODE && env.VITE_RAZORPAY_MODE !== "order") {
    add("WARN", "rzp-mode", `Unknown VITE_RAZORPAY_MODE="${env.VITE_RAZORPAY_MODE}" (treated as one-time order)`);
  } else add("PASS", "rzp-mode", "Razorpay in one-time 30-day order mode (paywall must not say 'renews')");

  if (truthy(env.VITE_ADS_ENABLED)) {
    const unit = env.VITE_ADMOB_BANNER_UNIT_ID ?? "";
    if (!/^ca-app-pub-\d{16}\/\d{10}$/.test(unit)) add(target === "production" ? "FAIL" : "WARN", "ads-unit", "VITE_ADS_ENABLED=true but VITE_ADMOB_BANNER_UNIT_ID is missing/malformed (falls back to Google's TEST banner)");
    else if (unit.includes(GOOGLE_TEST_PUBLISHER)) add(target === "production" ? "FAIL" : "WARN", "ads-unit", "Banner unit is Google's sample TEST unit — earns nothing");
    else add("PASS", "ads-unit", "Real banner unit id format");
    if (target === "staging" && /^ca-app-pub-\d{16}\/\d{10}$/.test(unit) && !unit.includes(GOOGLE_TEST_PUBLISHER)) {
      add("WARN", "ads-live-on-staging", "A REAL ad unit on a staging build: never tap your own live ads (AdMob suspends accounts for it); register your phone as a test device.");
    }
  } else add("PASS", "ads-flag", "Ads off (VITE_ADS_ENABLED not true)");

  if (target === "production") {
    const missing = ["VITE_DMCA_AGENT_NAME", "VITE_DMCA_AGENT_EMAIL", "VITE_DMCA_AGENT_ADDRESS"].filter((k) => !env[k]);
    if (missing.length) add("WARN", "dmca-agent", `Copyright page has no designated agent (${missing.join(", ")} unset). Register one at dmca.copyright.gov (~$6) and set them, or you lose DMCA safe harbor for user uploads.`);
    else add("PASS", "dmca-agent", "DMCA agent details configured");
  }

  // ---- repo static checks -----------------------------------------------------
  for (const f of MONETIZATION_FUNCTIONS) {
    if (!repo.functionDirs.includes(f)) add("FAIL", `fn-${f}`, `Edge function directory missing: supabase/functions/${f}`);
  }
  for (const f of WEBHOOK_FUNCTIONS) {
    const re = new RegExp(`\\[functions\\.${f}\\][^\\[]*verify_jwt\\s*=\\s*false`);
    if (!re.test(repo.configToml)) add("FAIL", `jwt-${f}`, `config.toml lacks verify_jwt=false for ${f} (gateway would 401 every callback)`);
    else add("PASS", `jwt-${f}`, `${f}: verify_jwt=false is set`);
  }
  for (const frag of ["monetization_entitlements_foundation", "pause_pro_sales"]) {
    if (!repo.migrations.some((m) => m.includes(frag))) add("FAIL", `mig-${frag}`, `Migration containing "${frag}" not found`);
  }
  const appId = (repo.admobXml.match(/duospace_admob_app_id[^>]*>\s*([^<\s]+)/) ?? [])[1] ?? "";
  if (!/^ca-app-pub-\d{16}~\d{10}$/.test(appId)) add("FAIL", "admob-app-id", "AdMob App ID missing/malformed in the plugin resource (SDK crashes at startup)");
  else if (appId.includes(GOOGLE_TEST_PUBLISHER)) add("WARN", "admob-app-id", "AdMob App ID is Google's sample id");
  else add("PASS", "admob-app-id", "AdMob App ID present");

  // ---- server secrets ---------------------------------------------------------
  if (!secrets) {
    add("WARN", "secrets", "No --secrets-file given: server secrets NOT checked");
    return r;
  }
  const must = ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "BILLING_ACCOUNT_HMAC_SECRET"];
  for (const k of must) if (!secrets[k]) add("FAIL", `secret-${k}`, `${k} is not set`);
  const kid = secrets.RAZORPAY_KEY_ID ?? "";
  if (kid) {
    if (target === "staging" && !kid.startsWith("rzp_test_")) add("FAIL", "rzp-key-mode", "Staging must use an rzp_test_ key id");
    else if (target === "production" && !kid.startsWith("rzp_live_")) add("WARN", "rzp-key-mode", "Production target but key id is not rzp_live_ (fine only while you still test on production)");
    else add("PASS", "rzp-key-mode", `Key id matches target (${kid.slice(0, 9)}…)`);
  }
  const hmac = secrets.BILLING_ACCOUNT_HMAC_SECRET ?? "";
  if (hmac && hmac.length < 32) add("FAIL", "hmac-strength", "BILLING_ACCOUNT_HMAC_SECRET is shorter than 32 chars (use `openssl rand -hex 32`)");
  if (secrets.RAZORPAY_WEBHOOK_SECRET && secrets.RAZORPAY_WEBHOOK_SECRET === secrets.RAZORPAY_KEY_SECRET) add("FAIL", "webhook-secret-reuse", "Webhook secret must differ from the API key secret");

  const play = secrets.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  if (!play) add("WARN", "play-secrets", "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON not set: Play purchases fail closed (grant nothing)");
  else {
    try {
      const j = JSON.parse(play);
      if (!j.client_email || !j.private_key) add("FAIL", "play-json", "Service-account JSON lacks client_email/private_key");
      else add("PASS", "play-json", "Service-account JSON parses and has client_email/private_key");
    } catch {
      add("FAIL", "play-json", "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not valid JSON (quote it as a single line)");
    }
    for (const k of ["PUBSUB_PUSH_AUDIENCE", "PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL"]) {
      if (!secrets[k]) add("FAIL", `secret-${k}`, `${k} not set: google-play-rtdn will answer 401 to every notification`);
    }
  }
  return r;
}

export function formatReport(results) {
  const icon = { PASS: "PASS", WARN: "WARN", FAIL: "FAIL" };
  const lines = results.map((x) => `[${icon[x.level]}] ${x.id}: ${x.msg}`);
  const c = (l) => results.filter((x) => x.level === l).length;
  lines.push("", `${c("PASS")} pass, ${c("WARN")} warn, ${c("FAIL")} fail`);
  return lines.join("\n");
}

// ---- CLI --------------------------------------------------------------------
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : undefined; };
  const target = arg("target");
  if (target !== "staging" && target !== "production") {
    console.error("Usage: node scripts/monetization-preflight.mjs --target staging|production [--client-env FILE] [--secrets-file FILE]");
    process.exit(2);
  }
  const read = (p) => fs.readFileSync(p, "utf8");
  const root = process.cwd();
  const clientEnvFile = arg("client-env");
  const secretsFile = arg("secrets-file");
  const fnRoot = path.join(root, "supabase/functions");
  const result = runPreflight({
    target,
    clientEnv: clientEnvFile ? parseDotenv(read(clientEnvFile)) : Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("VITE_"))),
    secrets: secretsFile ? parseDotenv(read(secretsFile)) : null,
    repo: {
      functionDirs: fs.existsSync(fnRoot) ? fs.readdirSync(fnRoot) : [],
      configToml: fs.existsSync(path.join(root, "supabase/config.toml")) ? read(path.join(root, "supabase/config.toml")) : "",
      migrations: fs.existsSync(path.join(root, "supabase/migrations")) ? fs.readdirSync(path.join(root, "supabase/migrations")) : [],
      admobXml: fs.existsSync(path.join(root, "native-plugins/admob/android/src/main/res/values/duospace_admob.xml"))
        ? read(path.join(root, "native-plugins/admob/android/src/main/res/values/duospace_admob.xml")) : "",
    },
  });
  console.log(formatReport(result));
  process.exit(result.some((x) => x.level === "FAIL") ? 1 : 0);
}

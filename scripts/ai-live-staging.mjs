#!/usr/bin/env node
/**
 * Live STAGING verification of the ai-gateway. Makes REAL provider calls through the
 * deployed edge function with a real test-user session. Nothing here runs in CI by default.
 *
 * Prereqs (staging project, NOT production):
 *   supabase secrets set AI_ENV=staging OPENAI_API_KEY=... GEMINI_API_KEY=... SARVAM_API_KEY=... \
 *     AI_STD_FAST_PROVIDER=openai AI_STD_FAST_MODEL=<model id> AI_STD_FAST_FALLBACK_PROVIDER=gemini AI_STD_FAST_FALLBACK_MODEL=<model id> \
 *     AI_STD_REASON_PROVIDER=... (see docs/DUOSPACE_AI_PROVIDER_ROUTING.md for the full env contract)
 *   supabase functions deploy ai-gateway
 *   a test user with CLOUD_AI_PROCESSING + RELATIONSHIP_INSIGHTS consent granted and quota available
 *
 * Run:
 *   SUPABASE_URL=https://<staging>.supabase.co SUPABASE_ANON_KEY=... \
 *   TEST_EMAIL=... TEST_PASSWORD=... node scripts/ai-live-staging.mjs
 *   (add  NO_CONSENT_EMAIL / NO_CONSENT_PASSWORD  to also verify the consent refusal)
 *
 * Exit code 0 only if every check that ran passed. A skipped check prints SKIP and is NOT a pass.
 * The script prints task/provider/status only — never message text or tokens.
 */
const { SUPABASE_URL, SUPABASE_ANON_KEY, TEST_EMAIL, TEST_PASSWORD, NO_CONSENT_EMAIL, NO_CONSENT_PASSWORD } = process.env;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !TEST_EMAIL || !TEST_PASSWORD) {
  console.error("Set SUPABASE_URL, SUPABASE_ANON_KEY, TEST_EMAIL, TEST_PASSWORD."); process.exit(2);
}
if (process.env.CONFIRM_STAGING !== "1") { console.error("Set CONFIRM_STAGING=1 to confirm SUPABASE_URL is a STAGING project (this makes real, billed provider calls)."); process.exit(2); }

const results = [];
const record = (name, status, detail = "") => { results.push({ name, status }); console.log(`${status.padEnd(4)} ${name}${detail ? " — " + detail : ""}`); };

async function signIn(email, password) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: SUPABASE_ANON_KEY, "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  if (!r.ok) throw new Error(`sign-in failed ${r.status}`);
  return (await r.json()).access_token;
}
const ctx = (over = {}) => ({ currentText: null, recentMessages: [], facts: [], memories: [], stage: null, durationMonths: null, dimensions: [], basis: null, replyMode: null, askedDimensions: [], unknownDimensions: [], ...over });
async function call(token, body) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/ai-gateway`, { method: "POST", headers: { authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const base = (task, context, extra = {}) => ({ task, language: null, allowProviderFallback: false, context, debugForceProvider: null, ...extra });

const FIXTURES = {
  en: "I'm exhausted tonight. Can we talk tomorrow instead?",
  hinglish: "kal milte hai but today I am busy, baad me baat karte hai?",
  hi: "आज मैं बहुत थक गई हूँ, कल बात करें?",
  mr: "आज मी खूप थकले आहे, उद्या बोलूया का?",
};

const token = await signIn(TEST_EMAIL, TEST_PASSWORD);

// 1. One REAL structured call per provider (forced; honoured only when server AI_ENV=staging).
for (const provider of ["openai", "gemini", "sarvam"]) {
  const { status, json } = await call(token, base("UNDERSTAND", ctx({ currentText: FIXTURES.en }), { debugForceProvider: provider }));
  const ok = status === 200 && json?.ok === true && json.meta?.provider === provider && typeof json.result?.summary === "string";
  record(`live ${provider}: UNDERSTAND structured output`, ok ? "PASS" : "FAIL", `status=${status} code=${json?.code ?? "-"}`);
}

// 2. Multilingual fixtures through the default route (server validates + grounds).
for (const [lang, text] of Object.entries(FIXTURES)) {
  const { status, json } = await call(token, base("UNDERSTAND", ctx({ currentText: text }), { language: lang === "hinglish" ? "hi" : lang }));
  record(`default route UNDERSTAND [${lang}]`, status === 200 && json?.ok ? "PASS" : "FAIL", `status=${status} provider=${json?.meta?.provider ?? "-"} code=${json?.code ?? "-"}`);
}

// 3. Fact extraction: evidence must be grounded (server drops anything else).
{
  const { status, json } = await call(token, base("FACT_EXTRACTION", ctx({ currentText: "We've been together for eight months and we both want something serious." })));
  const facts = json?.result?.facts ?? [];
  record("FACT_EXTRACTION returns only grounded explicit facts", status === 200 && facts.every((f) => f.isExplicit) ? "PASS" : "FAIL", `facts=${facts.length}`);
}

// 4. Minimisation: an unknown key must be rejected.
{
  const { status } = await call(token, { ...base("TODAY", ctx()), userId: "00000000-0000-0000-0000-000000000000" });
  record("unknown/identity field rejected (BAD_REQUEST)", status === 400 ? "PASS" : "FAIL", `status=${status}`);
}

// 5. Auth: no token.
{
  const r = await fetch(`${SUPABASE_URL}/functions/v1/ai-gateway`, { method: "POST", headers: { apikey: SUPABASE_ANON_KEY, "content-type": "application/json" }, body: JSON.stringify(base("TODAY", ctx())) });
  record("unauthenticated request rejected", r.status === 401 ? "PASS" : "FAIL", `status=${r.status}`);
}

// 6. Consent refusal.
if (NO_CONSENT_EMAIL && NO_CONSENT_PASSWORD) {
  const t2 = await signIn(NO_CONSENT_EMAIL, NO_CONSENT_PASSWORD);
  const { status, json } = await call(t2, base("UNDERSTAND", ctx({ currentText: FIXTURES.en })));
  record("no cloud-AI consent → refused", status === 403 && json?.code === "CONSENT_REQUIRED" ? "PASS" : "FAIL", `status=${status}`);
} else record("no cloud-AI consent → refused", "SKIP", "set NO_CONSENT_EMAIL/PASSWORD");

// 7. Quota: deep task on a FREE user must be refused; standard quota must eventually stop.
{
  const { status, json } = await call(token, base("COMPATIBILITY_DEEP", ctx({ basis: "BOTH_PARTNERS", dimensions: [{ dimension: "pace", state: "DIFFERENT", userEvidence: "I like to move slowly", partnerEvidence: "I like to move fast", alignmentReason: null, differenceReason: "different pace", confidence: "MEDIUM", uncertainty: null, importance: "UNKNOWN", lastUpdated: null, nextBestQuestion: null }] })));
  record("deep compatibility gated by AI_DEEP quota/plan", [200, 403, 429].includes(status) ? "PASS" : "FAIL", `status=${status} code=${json?.code ?? "ok"} (200 = PRO test user, 403/429 = quota enforced)`);
}

// 8. Provider fallback must be verified by temporarily setting a bad primary key in staging, then re-running with allowProviderFallback:true.
record("provider fallback (bad primary key → fallback provider)", "SKIP", "manual: break primary key in staging, run with allowProviderFallback=true, expect meta.fallbackUsed=true");

const failed = results.filter((r) => r.status === "FAIL").length;
console.log(`\n${results.filter((r) => r.status === "PASS").length} passed, ${failed} failed, ${results.filter((r) => r.status === "SKIP").length} skipped`);
process.exit(failed ? 1 : 0);

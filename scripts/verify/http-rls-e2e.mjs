#!/usr/bin/env node
/**
 * Phase 3H — HTTP auth + RLS verification against the STAGING Supabase project.
 *
 * Exercises the REAL path: GoTrue sign-in → real JWT → PostgREST → RLS →
 * response, with three throw-away users (A, B partners; C stranger) and an
 * anonymous client. Creates the users, runs the matrix, deletes the users
 * (their shares are removed by ON DELETE CASCADE), and writes a JSON report.
 *
 * Usage (on a machine that can reach supabase.co; NEVER in CI logs):
 *   STAGING_URL=https://otaficrlkiscaihdwxnt.supabase.co \
 *   STAGING_ANON_KEY=... \
 *   STAGING_SERVICE_ROLE_KEY=... \
 *   node scripts/verify/http-rls-e2e.mjs
 *
 * The service-role key is used ONLY to create/delete the test users and to
 * link A↔B (as the linking RPC would). Every security assertion runs with
 * real user JWTs or the anon key. The script refuses to run against
 * production. No keys, passwords or tokens are printed or written.
 */
import { createClient } from "@supabase/supabase-js";
import { randomUUID, randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";

const PRODUCTION_REF = "jzlpelxwzjjpddqcrtpu";
const { STAGING_URL: URL_, STAGING_ANON_KEY: ANON, STAGING_SERVICE_ROLE_KEY: SERVICE } = process.env;
if (!URL_ || !ANON || !SERVICE) { console.error("Set STAGING_URL, STAGING_ANON_KEY, STAGING_SERVICE_ROLE_KEY."); process.exit(2); }
if (URL_.includes(PRODUCTION_REF)) { console.error("Refusing to run against PRODUCTION."); process.exit(2); }

const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(URL_, SERVICE, opts);
const results = [];
const record = (id, name, expected, actual, pass, note = "") => { results.push({ id, name, expected, actual, result: pass ? "PASS" : "FAIL", note }); console.log(`${pass ? "PASS" : "FAIL"}  ${id}  ${name}${pass ? "" : `  (expected ${expected}, got ${actual})`}`); };
const run = Date.now().toString(36);
const pw = () => randomBytes(18).toString("base64url");
const users = {};

/** In-memory storage so we can inspect what the auth client keeps. */
function memoryStorage() { const m = new Map(); return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }; }

async function makeUser(label) {
  const email = `p3h-${label.toLowerCase()}-${run}@example.invalid`, password = pw();
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser ${label}: ${error.message}`);
  users[label] = { id: data.user.id, email, password };
}
async function signedIn(label) {
  const c = createClient(URL_, ANON, opts);
  const { data, error } = await c.auth.signInWithPassword({ email: users[label].email, password: users[label].password });
  if (error) throw new Error(`sign-in ${label}: ${error.message}`);
  return { c, session: data.session };
}
const memPayload = (memoryId, statement) => ({ v: 1, kind: "MEMORY", memoryId, category: "PREFERENCE", topic: "planning", statement, position: null, lastConfirmedAt: new Date().toISOString() });
const share = (c, owner, recipient, itemRef, payload, kind = "MEMORY") =>
  c.from("relationship_shares").insert({ owner_id: owner, recipient_id: recipient, kind, item_ref: itemRef, payload, payload_hash: "h" }).select("id").maybeSingle();
/** The app's revokeShare query after the F1 fix (sharing.ts). */
const appRevoke = (c, owner, id) => c.from("relationship_shares").update({ revoked_at: new Date().toISOString() }).eq("id", id).eq("owner_id", owner).is("revoked_at", null).select("kind, item_ref").maybeSingle();

async function main() {
  for (const l of ["A", "B", "C"]) await makeUser(l);
  const A = users.A.id, B = users.B.id, C = users.C.id;
  // link A <-> B exactly as the linking RPC does (service role bypasses the partner_id guard)
  for (const [u, p] of [[A, B], [B, A]]) { const { error } = await admin.from("profiles").update({ partner_id: p }).eq("user_id", u); if (error) throw new Error(`link: ${error.message}`); }

  // ── HTTP auth ───────────────────────────────────────────────────────────
  const a = await signedIn("A"), b = await signedIn("B"), c = await signedIn("C");
  record("H1", "A signs in and gets a real JWT session", "session", a.session ? "session" : "none", !!a.session?.access_token);
  const { data: who } = await a.c.auth.getUser();
  record("H2", "JWT resolves to A on the server", A, who?.user?.id, who?.user?.id === A);
  const bad = await createClient(URL_, ANON, opts).auth.signInWithPassword({ email: users.A.email, password: "wrong-" + pw() });
  record("H3", "wrong password rejected", "error", bad.error ? "error" : "session", !!bad.error && !bad.data.session);
  const refreshed = await a.c.auth.refreshSession();
  record("H4", "session refresh issues a new access token", "new token", refreshed.data.session?.access_token && refreshed.data.session.access_token !== a.session.access_token ? "new token" : "same/none", !!refreshed.data.session && refreshed.data.session.access_token !== a.session.access_token);
  const forged = createClient(URL_, ANON, { ...opts, global: { headers: { Authorization: `Bearer ${a.session.access_token.slice(0, -4)}xxxx` } } });
  const fr = await forged.from("relationship_shares").select("id");
  record("H5", "tampered JWT rejected by the API", "error", fr.error ? `error ${fr.error.code ?? ""}` : `rows ${fr.data?.length}`, !!fr.error);

  // ── App-path RLS with real JWTs ─────────────────────────────────────────
  const s1 = await share(a.c, A, B, `m-${run}`, memPayload(`m-${run}`, "A quick text when plans change helps me."));
  record("R1", "A shares a valid memory with partner B", "row", s1.error ? s1.error.message : "row", !s1.error && !!s1.data?.id);
  const bRead = await b.c.from("relationship_shares").select("id, payload").eq("owner_id", A);
  record("R2", "B reads exactly A's shared memory", "1 row", `${bRead.data?.length ?? "error"} row(s)`, bRead.data?.length === 1);
  const cRead = await c.c.from("relationship_shares").select("id");
  record("R3", "stranger C reads nothing", "0 rows", `${cRead.data?.length ?? "error"}`, cRead.data?.length === 0);
  const anonC = createClient(URL_, ANON, opts);
  const anR = await anonC.from("relationship_shares").select("id");
  record("R4", "anonymous client reads nothing", "0 rows or error", anR.error ? "error" : `${anR.data.length} rows`, !!anR.error || anR.data.length === 0);
  const anW = await share(anonC, A, B, `anon-${run}`, memPayload(`anon-${run}`, "x"));
  record("R5", "anonymous insert rejected", "error", anW.error ? "error" : "inserted", !!anW.error);
  const toC = await share(a.c, A, C, `c-${run}`, memPayload(`c-${run}`, "x"));
  record("R6", "A cannot share to non-partner C", "error", toC.error ? "error" : "inserted", !!toC.error);
  const forge = await share(c.c, A, B, `f-${run}`, memPayload(`f-${run}`, "x"));
  record("R7", "C cannot forge a share owned by A", "error", forge.error ? "error" : "inserted", !!forge.error);
  const hidden = await share(a.c, A, B, `h-${run}`, { ...memPayload(`h-${run}`, "x"), position: { key: "x", value: "no", hidden: "chat history" } });
  record("R8", "hidden data in position rejected (D3)", "error", hidden.error ? "error" : "inserted", !!hidden.error);
  const bEdit = await b.c.from("relationship_shares").update({ revoked_at: new Date().toISOString() }).eq("id", s1.data.id).select("id");
  record("R9", "B cannot withdraw A's share", "0 rows", `${bEdit.data?.length ?? "error"}`, !bEdit.error ? bEdit.data.length === 0 : true);
  const partnerSelf = await c.c.from("profiles").update({ partner_id: A }).eq("user_id", C).select("user_id");
  record("R10", "C cannot self-assign A as partner", "error", partnerSelf.error ? "error" : `${partnerSelf.data?.length} rows`, !!partnerSelf.error);

  // ── Withdraw + F1 (re-revoke) through the API ───────────────────────────
  const w1 = await appRevoke(a.c, A, s1.data.id);
  record("W1", "A withdraws with the app's query", "row", w1.error ? w1.error.message : w1.data ? "row" : "none", !w1.error && !!w1.data);
  const bAfter = await b.c.from("relationship_shares").select("id").eq("id", s1.data.id);
  record("W2", "B loses access immediately", "0 rows", `${bAfter.data?.length}`, bAfter.data?.length === 0);
  const w2 = await appRevoke(a.c, A, s1.data.id);
  record("W3", "F1: withdrawing again is a no-op, not an error", "no error, no row", w2.error ? `error ${w2.error.message}` : w2.data ? "row" : "no error, no row", !w2.error && !w2.data);
  const old = await a.c.from("relationship_shares").update({ revoked_at: new Date().toISOString() }).eq("id", s1.data.id).eq("owner_id", A).select("id").maybeSingle();
  record("W4", "pre-fix query (no revoked_at filter) still errors — documents why F1 was needed", "error", old.error ? "error" : "ok", !!old.error);

  // ── Session isolation on ONE client (account switch) ────────────────────
  const store = memoryStorage();
  const shared = createClient(URL_, ANON, { auth: { persistSession: true, autoRefreshToken: false, storage: store, storageKey: "p3h-auth" } });
  await shared.auth.signInWithPassword({ email: users.A.email, password: users.A.password });
  const asA = await shared.from("relationship_shares").select("id").eq("owner_id", A);
  await shared.auth.signOut();
  const leftover = [...store.m.keys()].filter((k) => k.startsWith("p3h-auth"));
  record("S1", "sign-out removes A's session from storage", "no keys", leftover.length ? leftover.join(",") : "no keys", leftover.length === 0);
  await shared.auth.signInWithPassword({ email: users.B.email, password: users.B.password });
  const { data: nowWho } = await shared.auth.getUser();
  record("S2", "after switching, the client is B", B, nowWho?.user?.id, nowWho?.user?.id === B);
  const asB = await shared.from("relationship_shares").select("id").eq("owner_id", A);
  record("S3", "B's session sees none of A's own (withdrawn) rows that A could see", `0 (A saw ${asA.data?.length})`, `${asB.data?.length}`, asB.data?.length === 0);
  await shared.auth.signOut();

  // ── Unlink via profile change (revocation-by-policy) ────────────────────
  const s2 = await share(a.c, A, B, `u-${run}`, memPayload(`u-${run}`, "Before unlink."));
  await admin.from("profiles").update({ partner_id: null }).in("user_id", [A, B]);
  const bUnl = await b.c.from("relationship_shares").select("id").eq("id", s2.data?.id ?? randomUUID());
  record("U1", "after unlink B cannot read A's live share (SELECT re-checks the link)", "0 rows", `${bUnl.data?.length}`, bUnl.data?.length === 0);
  const again = await share(a.c, A, B, `u2-${run}`, memPayload(`u2-${run}`, "x"));
  record("U2", "after unlink A cannot share to ex-partner", "error", again.error ? "error" : "inserted", !!again.error);
}

let fatal = null;
try { await main(); } catch (e) { fatal = String(e?.message ?? e); console.error("FATAL:", fatal); }
finally {
  for (const u of Object.values(users)) await admin.auth.admin.deleteUser(u.id).catch(() => {});
  const pass = results.filter((r) => r.result === "PASS").length;
  const report = { phase: "3H", ranAt: new Date().toISOString(), target: new globalThis.URL(URL_).host, total: results.length, pass, fail: results.length - pass, fatal, results };
  mkdirSync("docs/eval", { recursive: true });
  writeFileSync("docs/eval/phase3h_http_rls.json", JSON.stringify(report, null, 2) + "\n");
  console.log(`\n${pass}/${results.length} PASS${fatal ? " — stopped early: " + fatal : ""}. Report: docs/eval/phase3h_http_rls.json (no secrets inside). Test users deleted.`);
  process.exit(fatal || pass !== results.length ? 1 : 0);
}

#!/usr/bin/env node
/**
 * RLS coverage gate — ADVISORY, NOT A SECURITY PROOF.
 *
 * Reads every SQL file in supabase/migrations/ IN FILENAME (TIMESTAMP) ORDER
 * and replays CREATE TABLE / ALTER TABLE ... ENABLE|DISABLE ROW LEVEL
 * SECURITY / CREATE POLICY / DROP POLICY / DROP TABLE statements in the
 * order they appear, tracking which named policies are *currently active*
 * per table — not just "was CREATE POLICY ever mentioned for this table."
 *
 * PHASE 8.5: rewritten from an earlier .ts version and converted to plain
 * Node ESM (.mjs) to match every other script in this directory
 * (patch-native-permissions.mjs, verify-android-build.mjs,
 * apply-whitelabel.mjs) — this repo has no TypeScript runner (no tsx/
 * ts-node in devDependencies, and CI's Node 20 can't execute .ts directly),
 * so a .ts version of this script could never actually run in CI without
 * adding a new dependency. Converting to .mjs needs nothing extra.
 *
 * What changed in the rewrite and why (see docs/RLS_SECURITY_MATRIX.md
 * section 18 for full context):
 *
 *   1. DROP POLICY is now honored. The old version only ever counted
 *      `CREATE POLICY ... ON <table>` occurrences and never looked at
 *      DROP POLICY at all - a table whose only policy was created and then
 *      dropped (with nothing recreated) would still "pass." This script's
 *      own project has a real historical example of the opposite failure
 *      mode too (a stale policy silently coexisting because a DROP used a
 *      different name than a later CREATE) - so this rewrite tracks named
 *      policies precisely, by name, per table, rather than just a count.
 *
 *   2. Comments are stripped before matching, so a `-- CREATE POLICY ...`
 *      left in a comment (or a commented-out block) can't be counted as
 *      active policy evidence.
 *
 *   3. storage.objects is tracked as its own explicit entry, separate from
 *      `public.*` tables. It is never created via `CREATE TABLE` in this
 *      repo (Supabase manages it), so the previous version's table
 *      extraction never found it at all - meaning storage bucket policies,
 *      some of the most security-relevant policies in this schema, were
 *      entirely unchecked. This version scans for `ON storage.objects`
 *      policies explicitly.
 *
 *   4. A single combined regex pass per file (rather than separate passes
 *      per statement kind) preserves true left-to-right statement order
 *      within a file, which matters for replay correctness - running
 *      separate regexes and merging by naive concatenation would not
 *      reliably preserve interleaving.
 *
 * WHAT THIS STILL CANNOT DO (do not treat a passing run as a security
 * clearance):
 *   - It has no idea whether a policy's USING/WITH CHECK clause is actually
 *     correct or too broad - a table with a `USING (true)` policy passes
 *     this check exactly the same as a tightly-scoped one. That class of
 *     bug (see docs/RLS_SECURITY_MATRIX.md, the countdowns/memories/taps/
 *     daily_answers/playlist_songs/invite_links finding) is NOT detectable
 *     by this script and never will be without semantic understanding of
 *     each policy's intent.
 *   - It is regex-based text analysis of migration files, not a query
 *     against the live database. If migrations were applied out of order,
 *     partially, against a different project than this repo's history
 *     implies (see docs/RLS_SECURITY_MATRIX.md section 0 - this repo shows
 *     evidence of more than one full schema baseline), or hand-edited
 *     directly in the Supabase dashboard, this script's picture of
 *     "current state" will be wrong and it cannot know that.
 *   - Table/policy name extraction is regex-based, not a real SQL parser.
 *     Unusual quoting, dynamic SQL (`EXECUTE format(...)`), or policies
 *     created inside a DO $$ ... $$ block with string-built SQL will not
 *     be seen.
 *
 * This is a lint-style regression guard for "did someone add a table and
 * forget RLS entirely" or "did a DROP POLICY leave a table with zero active
 * policies" - nothing more. See docs/RLS_SECURITY_MATRIX.md for the actual
 * security review, which required a human reading every policy's clause.
 *
 * Run locally: `node scripts/check-rls-coverage.mjs`
 * CI: see .github/workflows/ci.yml
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = "supabase/migrations";

// Tables intentionally left without RLS, or with intentionally-public
// policies - add here ONLY with a written justification, cross-referenced
// in docs/RLS_SECURITY_MATRIX.md.
const ALLOWED_NO_RLS = new Set([
  // (none currently - every public table in this schema has RLS enabled)
]);

function loadFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ name: f, text: readFileSync(join(MIGRATIONS_DIR, f), "utf8") }));
}

/**
 * Strip -- line comments and block comments so neither can be mistaken for
 * active SQL. Does not attempt to special-case a comment marker inside a
 * string literal (rare in this codebase's migrations; a real SQL parser
 * would be needed to handle that correctly - noted as a limitation above).
 */
function stripComments(sql) {
  let out = sql.replace(/\/\*[\s\S]*?\*\//g, " ");
  out = out.replace(/--[^\n]*/g, " ");
  return out;
}

const TABLE_TOKEN = `(storage\\.objects|(?:public\\.)?"?[a-zA-Z0-9_]+"?)`;

const COMBINED_RE = new RegExp(
  [
    `create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${TABLE_TOKEN}`,
    `drop\\s+table\\s+(?:if\\s+exists\\s+)?${TABLE_TOKEN}`,
    `alter\\s+table\\s+(?:if\\s+exists\\s+)?${TABLE_TOKEN}\\s+enable\\s+row\\s+level\\s+security`,
    `alter\\s+table\\s+(?:if\\s+exists\\s+)?${TABLE_TOKEN}\\s+disable\\s+row\\s+level\\s+security`,
    `create\\s+policy\\s+"([^"]+)"\\s+on\\s+${TABLE_TOKEN}`,
    `drop\\s+policy\\s+(?:if\\s+exists\\s+)?"([^"]+)"\\s+on\\s+${TABLE_TOKEN}`,
  ].join("|"),
  "gi",
);

function normTable(raw) {
  const bare = raw.replace(/^public\./i, "").replace(/"/g, "");
  return bare.toLowerCase() === "storage.objects" ? "storage.objects" : bare.toLowerCase();
}

function extractEvents(sql) {
  const events = [];
  let m;
  COMBINED_RE.lastIndex = 0;
  while ((m = COMBINED_RE.exec(sql)) !== null) {
    const pos = m.index;
    if (m[1]) events.push({ kind: "create_table", table: normTable(m[1]), pos });
    else if (m[2]) events.push({ kind: "drop_table", table: normTable(m[2]), pos });
    else if (m[3]) events.push({ kind: "enable_rls", table: normTable(m[3]), pos });
    else if (m[4]) events.push({ kind: "disable_rls", table: normTable(m[4]), pos });
    else if (m[5] && m[6]) events.push({ kind: "create_policy", policy: m[5], table: normTable(m[6]), pos });
    else if (m[7] && m[8]) events.push({ kind: "drop_policy", policy: m[7], table: normTable(m[8]), pos });
  }
  return events;
}

// ── replay ────────────────────────────────────────────────────────────────
const files = loadFiles();

const knownTables = new Set();
const droppedTables = new Set();
const rlsEnabled = new Set();
const activePolicies = new Map(); // table -> Set of currently-active policy names

function policiesFor(table) {
  let s = activePolicies.get(table);
  if (!s) { s = new Set(); activePolicies.set(table, s); }
  return s;
}

for (const file of files) {
  const clean = stripComments(file.text);
  const events = extractEvents(clean);
  for (const ev of events) {
    switch (ev.kind) {
      case "create_table":
        knownTables.add(ev.table);
        droppedTables.delete(ev.table);
        break;
      case "drop_table":
        droppedTables.add(ev.table);
        activePolicies.delete(ev.table);
        rlsEnabled.delete(ev.table);
        break;
      case "enable_rls":
        rlsEnabled.add(ev.table);
        break;
      case "disable_rls":
        rlsEnabled.delete(ev.table);
        break;
      case "create_policy":
        policiesFor(ev.table).add(ev.policy);
        break;
      case "drop_policy":
        policiesFor(ev.table).delete(ev.policy);
        break;
    }
  }
}

// ── report ───────────────────────────────────────────────────────────────
const failures = [];
const liveTables = Array.from(knownTables).filter((t) => !droppedTables.has(t)).sort();

for (const table of liveTables) {
  if (ALLOWED_NO_RLS.has(table)) continue;
  if (!rlsEnabled.has(table)) {
    failures.push(`RLS not enabled: ${table}`);
    continue;
  }
  const active = policiesFor(table);
  if (active.size === 0) {
    failures.push(`RLS enabled but zero currently-active policies (created then dropped, or never created): ${table}`);
  }
}

// storage.objects is never created via CREATE TABLE in this schema, so it's
// checked separately from the public-table loop above.
const storageObjectsPolicies = policiesFor("storage.objects");
if (storageObjectsPolicies.size === 0) {
  failures.push("storage.objects: zero currently-active policies found (expected many, one set per bucket)");
}

console.log(`Scanned ${files.length} migration files.`);
console.log(`Tracked ${liveTables.length} live public tables + storage.objects.`);
console.log(`storage.objects currently-active policy count: ${storageObjectsPolicies.size}`);

if (failures.length > 0) {
  console.error("\nRLS coverage check FAILED:");
  failures.forEach((f) => console.error("  - " + f));
  console.error(
    "\nThis is a basic presence check only (RLS enabled + at least one active\n" +
    "named policy per table). It does NOT verify policy clauses are correctly\n" +
    "scoped - see docs/RLS_SECURITY_MATRIX.md for that review. A passing run\n" +
    "of this script is not a security clearance.",
  );
  process.exit(1);
}

console.log(
  "\n✓ Basic RLS presence check passed - every live table has RLS enabled and\n" +
  "  at least one currently-active policy, and storage.objects has policies.\n" +
  "  This does NOT verify policies are correctly scoped. See\n" +
  "  docs/RLS_SECURITY_MATRIX.md for the actual security review.",
);

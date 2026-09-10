/**
 * RLS coverage gate.
 *
 * Reads every SQL file in supabase/migrations/ and asserts that every public
 * table created has:
 *   1) ENABLE ROW LEVEL SECURITY
 *   2) at least one CREATE POLICY referencing it
 *
 * Exits with non-zero status if any table is missing RLS or has zero policies.
 *
 * Run locally: `bun run scripts/check-rls-coverage.ts`
 * CI: see .github/workflows/ci-security.yml
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = "supabase/migrations";
const ALLOWED_NO_RLS = new Set<string>([
  // add here only if intentionally public, with justification
]);

function load(): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return files.map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8")).join("\n");
}

function uniq<T>(xs: T[]): T[] { return Array.from(new Set(xs)); }

function extractTables(sql: string): string[] {
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-zA-Z0-9_]+)"?/gi;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) out.push(m[1]);
  return uniq(out);
}

function hasRlsEnabled(sql: string, table: string): boolean {
  const re = new RegExp(
    `alter\\s+table\\s+(?:public\\.)?"?${table}"?\\s+enable\\s+row\\s+level\\s+security`,
    "i",
  );
  return re.test(sql);
}

function policyCount(sql: string, table: string): number {
  const re = new RegExp(
    `create\\s+policy[\\s\\S]*?on\\s+(?:public\\.)?"?${table}"?`,
    "gi",
  );
  return (sql.match(re) ?? []).length;
}

const sql = load();
const tables = extractTables(sql);
const failures: string[] = [];

for (const table of tables) {
  if (ALLOWED_NO_RLS.has(table)) continue;
  if (!hasRlsEnabled(sql, table)) {
    failures.push(`❌ ${table}: RLS not enabled`);
    continue;
  }
  const count = policyCount(sql, table);
  if (count === 0) {
    failures.push(`❌ ${table}: RLS enabled but 0 policies`);
  }
}

if (failures.length > 0) {
  console.error("RLS coverage check FAILED:");
  failures.forEach((f) => console.error("  " + f));
  console.error(`\nChecked ${tables.length} tables, ${failures.length} violations.`);
  process.exit(1);
}

console.log(`✓ RLS coverage OK — ${tables.length} tables, all have RLS + policies.`);

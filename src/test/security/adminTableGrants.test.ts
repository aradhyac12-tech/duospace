/**
 * RLS-003 (security audit v3.22.9): static migration lint. Fails CI if any
 * migration grants write access on an admin/config table to anon,
 * authenticated or public. Reads are checked separately per table.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "..", "..", "..", "supabase", "migrations");
const PROTECTED = ["app_releases", "commission_rates", "admin_audit_log", "admin_allowlist"];
const WRITE = /\b(ALL|INSERT|UPDATE|DELETE|TRUNCATE)\b/i;

function grants() {
  const out: { file: string; stmt: string }[] = [];
  for (const f of readdirSync(DIR).filter((x) => x.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(DIR, f), "utf8").replace(/--.*$/gm, "");
    for (const m of sql.matchAll(/\bGRANT\b[^;]*;/gi)) out.push({ file: f, stmt: m[0].replace(/\s+/g, " ") });
  }
  return out;
}

describe("admin/config table grants (RLS-003)", () => {
  it("never grants write privileges on protected tables to anon/authenticated/public", () => {
    const bad = grants().filter(({ stmt }) =>
      PROTECTED.some((t) => new RegExp(`ON\\s+(TABLE\\s+)?(public\\.)?${t}\\b`, "i").test(stmt)) &&
      /\bTO\b[^;]*\b(anon|authenticated|public)\b/i.test(stmt) &&
      WRITE.test(stmt.split(/\bON\b/i)[0]),
    );
    expect(bad).toEqual([]);
  });

  it("never grants anything on admin_audit_log / admin_allowlist / commission_rates to client roles", () => {
    const bad = grants().filter(({ stmt }) =>
      ["admin_audit_log", "admin_allowlist", "commission_rates"].some((t) => new RegExp(`ON\\s+(TABLE\\s+)?(public\\.)?${t}\\b`, "i").test(stmt)) &&
      /\bTO\b[^;]*\b(anon|authenticated|public)\b/i.test(stmt),
    );
    expect(bad).toEqual([]);
  });
});

/**
 * Static guard: the self-hosted stack is the ONLY calling provider.
 * Fails if Daily's SDK, edge function, adapter or provider switch comes back
 * into executable code or configuration.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs|json|kt|swift|toml|yaml|yml)$/.test(name) || /^\.env/.test(name)) out.push(p);
  }
  return out;
}
const EXEC_DIRS = ["src", "supabase/functions", "native", "native-plugins", "infrastructure", "scripts"];
const files = EXEC_DIRS.filter((d) => existsSync(join(ROOT, d))).flatMap((d) => walk(join(ROOT, d)))
  // Tests may assert that removed APIs are absent, and the config checker
  // must name the obsolete variable in order to reject it.
  .filter((f) => !f.includes(`${join("src", "test")}`) && !f.endsWith("check-calling-config.mjs"));

describe("Daily is removed from the production runtime", () => {
  it("no Daily package in package.json", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect({ ...pkg.dependencies, ...pkg.devDependencies }["@daily-co/daily-js"]).toBeUndefined();
    expect(pkg.dependencies["livekit-client"]).toBeDefined();
  });

  it("lockfile contains livekit-client and no Daily package", () => {
    const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
    expect(lock.packages["node_modules/livekit-client"]).toBeDefined();
    expect(lock.packages["node_modules/@daily-co/daily-js"]).toBeUndefined();
  });

  it("no daily-call edge function, Daily adapter, or Daily hook exists", () => {
    for (const p of ["supabase/functions/daily-call", "src/hooks/useDailyCall.ts", "src/lib/callEngine/DailyCallEngineAdapter.ts", "src/components/DailyKeyManager.tsx"]) {
      expect(existsSync(join(ROOT, p)), p).toBe(false);
    }
  });

  it("no executable file imports/invokes Daily or reads a provider switch", () => {
    const offenders: string[] = [];
    const patterns = [/@daily-co\//, /daily-js/, /["']daily-call["']/, /useDailyCall/, /DailyCallEngineAdapter/, /VITE_CALL_PROVIDER/, /setCallProviderOverride/, /\.daily\.co/, /DAILY_API_KEY/];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const re of patterns) if (re.test(text)) offenders.push(`${f.replace(ROOT, "")} :: ${re}`);
    }
    expect(offenders).toEqual([]);
  });
});

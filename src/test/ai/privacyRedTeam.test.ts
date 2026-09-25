/**
 * Privacy red team (static): the relationship-AI layer must not log content,
 * reach the network (except the SHA-256-verified model fetch), persist
 * content outside the encrypted store, or carry secrets.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..", "..");
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : []; });
const AI_FILES = [...walk(join(ROOT, "src/lib/relationship")), ...walk(join(ROOT, "src/lib/ai")), join(ROOT, "src/pages/Reflection.tsx")];
const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""); // strip comments
const rel = (f: string) => f.replace(ROOT + "/", "");

describe("privacy red team — relationship AI layer", () => {
  it("no console logging anywhere in the AI layer", () => {
    const hits = AI_FILES.filter((f) => /\bconsole\.(log|info|debug|warn|error|trace)\s*\(/.test(code(f))).map(rel);
    expect(hits).toEqual([]);
  });

  it("no error-reporting / analytics SDKs imported by the AI layer", () => {
    const hits = AI_FILES.filter((f) => /from\s+["'](@sentry|posthog|mixpanel|@amplitude|@segment|firebase\/analytics)/.test(code(f))).map(rel);
    expect(hits).toEqual([]);
  });

  it("the only network call in the AI layer is the integrity-verified model fetch", () => {
    const hits = AI_FILES.filter((f) => /\bfetch\s*\(|XMLHttpRequest|navigator\.sendBeacon|new\s+WebSocket|invokeEdgeFunction\s*\(/.test(code(f)))
      .map(rel).filter((f) => f !== "src/lib/relationship/localModel/manifest.ts" && !f.startsWith("src/lib/relationship/sharing"));
    expect(hits).toEqual([]);
  });

  it("no Supabase calls from the analysis path (sharing is the only, explicit, server feature)", () => {
    const analysis = AI_FILES.filter((f) => /relationship\/(pipeline|service|executionMode|provider|providers|localModel|e2eCloud)|lib\/ai\//.test(f));
    expect(analysis.filter((f) => /\bsupabase\b/.test(code(f))).map(rel)).toEqual([]);
  });

  it("localStorage is used only for the content-free runtime-state record", () => {
    const hits = AI_FILES.filter((f) => /localStorage\.setItem/.test(code(f))).map(rel);
    expect(hits).toEqual(["src/lib/relationship/service.ts"]);
    expect(code(join(ROOT, "src/lib/relationship/service.ts"))).toMatch(/localStorage\.setItem\(STATE_KEY, JSON\.stringify\(s\)\)/);
  });

  it("the model runtime never persists fetched files (custom cache put is a no-op) and browser cache is off", () => {
    const rt = code(join(ROOT, "src/lib/relationship/localModel/transformersWebRuntime.ts"));
    expect(rt).toMatch(/useBrowserCache = false/);
    expect(rt).toMatch(/put: async \(\) => \{\s*\}/);
  });

  it("no secrets, service-role keys or private keys referenced in the AI layer or as VITE_ vars", () => {
    const hits = AI_FILES.filter((f) => /SERVICE_ROLE|SUPABASE_SERVICE|API_SECRET|OPENAI|ANTHROPIC_API|privateKeyJwk|VITE_[A-Z_]*(SECRET|KEY)\b/.test(code(f))).map(rel);
    expect(hits).toEqual([]);
  });

  it("no service worker caches AI content", () => {
    const sw = walk(join(ROOT, "src")).filter((f) => /serviceWorker\.register|caches\.open/.test(code(f))).map(rel);
    for (const f of sw) expect(code(join(ROOT, f))).not.toMatch(/relationship|insight|reflection/i);
  });
});

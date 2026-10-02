import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

const DIR = "src/lib/relationship/dyadic";
const files = readdirSync(DIR).map((f) => [f, readFileSync(`${DIR}/${f}`, "utf8")] as const);

describe("Phase 3A privacy (static)", () => {
  it("the dyadic engine has no network, telemetry, analytics, cloud or service-role access", () => {
    for (const [f, src] of files) {
      expect(src, f).not.toMatch(/from\s+["'][^"']*(supabase|telemetry|analytics|e2eCloud|crash)/i);
      expect(src, f).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|service_role|SERVICE_ROLE|console\.(log|info|warn|error)/);
    }
  });
  it("no numeric score field exists in the result contract", () => {
    const types = files.find(([f]) => f === "types.ts")![1];
    const result = types.slice(types.indexOf("interface DyadicResult"), types.indexOf("export type CorrectionKind"));
    expect(result).not.toMatch(/:\s*number/);
    expect(result).not.toMatch(/score|compatib|health|rank/i);
  });
});

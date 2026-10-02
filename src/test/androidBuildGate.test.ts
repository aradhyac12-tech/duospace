/**
 * Regression for G1 (Phase 3G/3H): the Android dependency gate demanded an
 * impossible @capacitor/assets@^8 and blocked `cap:add:android` / `cap:sync`
 * for everyone. The fix must not weaken the check for real plugins.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const GATE = resolve("scripts/verify-android-build.mjs");
const runIn = (cwd: string) => spawnSync(process.execPath, [GATE, "--deps"], { cwd, encoding: "utf8" });
const fakeRepo = (deps: Record<string, string>, dev: Record<string, string> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "gate-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", dependencies: deps, devDependencies: dev }));
  return dir;
};

describe("Android dependency gate", () => {
  it("passes on the real repository (was failing on @capacitor/assets)", () => {
    const r = runIn(process.cwd());
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toContain("@capacitor/assets@");
  });
  it("still fails a REAL plugin with a mismatched major", () => {
    const r = runIn(fakeRepo({ "@capacitor/core": "^8.0.0", "@capacitor/preferences": "^5.0.0" }, { "@capacitor/assets": "^3.0.5" }));
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toContain("@capacitor/preferences@^5.0.0 is Capacitor 5.x");
  });
  it("does not flag the independently versioned @capacitor/assets CLI", () => {
    const r = runIn(fakeRepo({ "@capacitor/core": "^8.0.0" }, { "@capacitor/assets": "^3.0.5" }));
    expect(r.stdout + r.stderr).not.toContain("@capacitor/assets@^3.0.5 is Capacitor 3.x");
  });
});

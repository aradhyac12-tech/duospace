#!/usr/bin/env node
/**
 * Guarantees the build toolchain exists before `vite build` runs.
 *
 * WHY: a Vercel deploy failed with
 *     sh: line 1: vite: command not found
 *     Error: Command "vite build" exited with 127
 * Exit code 127 is "binary not on PATH" — i.e. the install step either never
 * ran, or ran with NODE_ENV=production / --omit=dev, which makes npm skip
 * devDependencies. vite, typescript and the vite plugins all live in
 * devDependencies, so the build binary simply was not there.
 *
 * Belt and braces, so this can never happen again on any CI:
 *   - .npmrc pins `production=false` / `omit=` so devDependencies always install.
 *   - vercel.json's installCommand passes --include=dev explicitly.
 *   - this script runs right before the build and, if node_modules/.bin/vite
 *     is STILL missing, installs dependencies itself instead of failing.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "node_modules", ".bin", process.platform === "win32" ? "vite.cmd" : "vite");

if (existsSync(bin)) {
  console.log("[ensure-build-deps] vite present — continuing to build.");
  process.exit(0);
}

console.warn("[ensure-build-deps] vite is missing from node_modules/.bin — installing dependencies (including devDependencies).");

const env = { ...process.env, NODE_ENV: "development", NPM_CONFIG_PRODUCTION: "false" };
const lockfile = existsSync(join(root, "package-lock.json"));
const args = lockfile
  ? ["ci", "--include=dev", "--no-audit", "--no-fund"]
  : ["install", "--include=dev", "--no-audit", "--no-fund"];

const result = spawnSync("npm", args, { cwd: root, stdio: "inherit", env, shell: process.platform === "win32" });

if (result.status !== 0) {
  console.error("[ensure-build-deps] dependency install failed — cannot build.");
  process.exit(result.status ?? 1);
}
if (!existsSync(bin)) {
  console.error("[ensure-build-deps] install finished but vite is still missing. Check that vite is listed in package.json devDependencies.");
  process.exit(1);
}
console.log("[ensure-build-deps] dependencies installed — continuing to build.");

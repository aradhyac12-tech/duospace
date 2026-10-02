#!/usr/bin/env node
/**
 * Offline lockfile consistency check (no network, no registry).
 *
 * `npm ci` fails when package.json and package-lock.json disagree, but it
 * needs a network to find that out. This script finds the same class of
 * problem statically so it can run anywhere, including CI before install:
 *
 *   1. every dependency/devDependency in package.json is in the lock's root
 *      entry with the SAME range;
 *   2. every registry dependency has a node_modules/<name> entry whose
 *      version satisfies the range (^, ~, exact, >=);
 *   3. every `file:` dependency (the local Capacitor plugins) is recorded as
 *      a link to the right directory, and that directory's own package.json
 *      dependencies match the lock's entry for it.
 *
 * It does NOT regenerate or edit the lock — only npm may do that:
 *   npm install --package-lock-only   (needs network)
 * A passing run is necessary, not sufficient, for `npm ci` to succeed.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const root = lock.packages?.[""] ?? {};
const errors = [];
const warns = [];

if (lock.name !== pkg.name) warns.push(`lock name "${lock.name}" != package.json name "${pkg.name}"`);
if (lock.version !== pkg.version) warns.push(`lock version "${lock.version}" != package.json version "${pkg.version}" (cosmetic for npm ci, but shows the lock is stale)`);

const parse = (v) => (v ?? "").replace(/^[\^~>=v\s]+/, "").split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
const cmp = (a, b) => { for (let i = 0; i < 3; i++) { if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0); } return 0; };
function satisfies(version, range) {
  const v = parse(version), r = parse(range);
  if (/^\d/.test(range)) return cmp(v, r) === 0;
  if (range.startsWith("^")) return cmp(v, r) >= 0 && (r[0] > 0 ? v[0] === r[0] : v[1] === r[1]);
  if (range.startsWith("~")) return cmp(v, r) >= 0 && v[0] === r[0] && v[1] === r[1];
  if (range.startsWith(">=")) return cmp(v, r) >= 0;
  return true; // ranges this script does not understand are not judged
}

for (const section of ["dependencies", "devDependencies"]) {
  const want = pkg[section] ?? {};
  const have = root[section] ?? {};
  for (const name of new Set([...Object.keys(want), ...Object.keys(have)])) {
    if (want[name] !== have[name]) {
      errors.push(`${section}.${name}: package.json has ${want[name] ?? "(absent)"} but the lock root has ${have[name] ?? "(absent)"}`);
      continue;
    }
    const spec = want[name];
    const entry = lock.packages?.[`node_modules/${name}`];
    if (spec.startsWith("file:")) {
      const dir = spec.slice(5).replace(/^\.\//, "");
      if (!entry || entry.link !== true || entry.resolved !== dir) {
        errors.push(`${name}: expected a link to ${dir} in the lock, found ${JSON.stringify(entry ?? null)}`);
        continue;
      }
      const pj = join(dir, "package.json");
      if (!existsSync(pj)) { errors.push(`${name}: ${pj} does not exist`); continue; }
      const local = JSON.parse(readFileSync(pj, "utf8"));
      const lockedLocal = lock.packages?.[dir];
      if (!lockedLocal) { errors.push(`${name}: no "${dir}" package entry in the lock`); continue; }
      for (const s of ["dependencies", "devDependencies", "peerDependencies"]) {
        if (JSON.stringify(local[s] ?? {}) !== JSON.stringify(lockedLocal[s] ?? {})) {
          errors.push(`${name}: ${s} in ${pj} differ from the lock's entry for ${dir}`);
        }
      }
    } else if (!entry) {
      errors.push(`${name}@${spec}: no node_modules/${name} entry in the lock`);
    } else if (!satisfies(entry.version, spec)) {
      errors.push(`${name}: lock has ${entry.version}, which does not satisfy ${spec}`);
    }
  }
}

warns.forEach((w) => console.warn("WARN  " + w));
if (errors.length) {
  console.error(`\nLockfile is OUT OF SYNC with package.json (${errors.length} problem${errors.length > 1 ? "s" : ""}):`);
  errors.forEach((e) => console.error("  - " + e));
  console.error("\n`npm ci` will fail. Regenerate with npm (needs network): npm install --package-lock-only");
  process.exit(1);
}
console.log("Lockfile agrees with package.json (static check). This does not replace `npm ci`.");

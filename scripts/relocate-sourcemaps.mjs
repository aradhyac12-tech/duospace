#!/usr/bin/env node
// PERF/SECURITY FIX (Phase 1 #12): vite.config.ts already switched from
// `sourcemap: false` to `sourcemap: "hidden"` in an earlier session so
// production crashes could actually be decoded — "hidden" stops the
// browser from *auto-fetching* the .map for every visitor, but it still
// writes the .map files into dist/, and dist/ is exactly what Vercel/
// Netlify serve as-is. Nothing in vercel.json or netlify.toml denied
// direct requests to those paths, so `<chunk>.js.map` was still fetchable
// by anyone who knew (or guessed) the URL — i.e. still publicly exposed,
// just not automatically.
//
// This moves every generated .map file out of dist/ into a sibling
// sourcemaps/ directory immediately after the build, before dist/ is
// handed to the host. sourcemaps/ is never deployed (it's outside the
// configured outputDirectory/publish path for both hosts), so the maps
// exist for private diagnostics — pull sourcemaps/ from the CI build
// artifact, or run this build locally — without ever being servable at
// the site's own domain.
import { readdirSync, statSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

const DIST_DIR = join(process.cwd(), "dist");
const SOURCEMAP_DIR = join(process.cwd(), "sourcemaps");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".map")) out.push(full);
  }
  return out;
}

function main() {
  let maps;
  try {
    maps = walk(DIST_DIR);
  } catch {
    console.warn("[relocate-sourcemaps] dist/ not found — skipping (did the build run?)");
    return;
  }
  if (maps.length === 0) {
    console.log("[relocate-sourcemaps] no .map files found in dist/ — nothing to relocate");
    return;
  }
  mkdirSync(SOURCEMAP_DIR, { recursive: true });
  for (const mapPath of maps) {
    const rel = mapPath.slice(DIST_DIR.length + 1);
    const dest = join(SOURCEMAP_DIR, rel);
    mkdirSync(join(dest, ".."), { recursive: true });
    renameSync(mapPath, dest);
  }
  console.log(`[relocate-sourcemaps] moved ${maps.length} sourcemap file(s) to sourcemaps/ (kept out of the deployed dist/)`);
}

main();

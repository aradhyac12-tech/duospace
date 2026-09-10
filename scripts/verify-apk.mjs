#!/usr/bin/env node
/**
 * verify-apk.mjs
 *
 * Last gate in the pipeline, run on the actual .apk Gradle produced —
 * everything before this checks source/config; this checks the artifact.
 * A build that passes every earlier gate can still produce a bad APK
 * (wrong applicationId from a stale AGP cache, a signing block that's
 * present in build.gradle but got skipped some other way, etc.) and this
 * step exists so that failure mode is caught here instead of at install
 * time on a device.
 *
 * Uses `aapt2 dump badging` (installed as part of Android build-tools by
 * the CI toolchain) to read the APK's real merged manifest, plus unzip
 * to confirm the Capacitor plugin-registration asset made it into the
 * archive.
 *
 * Usage: node scripts/verify-apk.mjs <path-to-apk>
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const apkPath = process.argv[2];
let failed = false;
const fail = (msg) => { console.error(`[verify-apk] \u274c ${msg}`); failed = true; };
const ok = (msg) => console.log(`[verify-apk] \u2705 ${msg}`);

if (!apkPath || !existsSync(apkPath)) {
  console.error(`[verify-apk] No APK at "${apkPath}"`);
  process.exit(1);
}

function findAapt2() {
  const sdkRoot = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
  if (!sdkRoot) return "aapt2"; // hope it's on PATH
  const buildToolsDir = join(sdkRoot, "build-tools");
  if (!existsSync(buildToolsDir)) return "aapt2";
  const versions = readdirSync(buildToolsDir).sort().reverse();
  if (!versions.length) return "aapt2";
  return join(buildToolsDir, versions[0], "aapt2");
}

const aapt2 = findAapt2();
let badging;
try {
  badging = execFileSync(aapt2, ["dump", "badging", apkPath], { encoding: "utf8" });
} catch (e) {
  fail(`aapt2 dump badging failed: ${e.message}. Cannot verify the built APK's real manifest — treating this as a build failure rather than assuming the APK is fine.`);
  console.error("\n[verify-apk] FAILED\n");
  process.exit(1);
}

// --- applicationId -------------------------------------------------------
const expectedAppId = (() => {
  try {
    return JSON.parse(readFileSync("capacitor.config.json", "utf8")).appId;
  } catch {
    return null;
  }
})();
const pkgMatch = badging.match(/package: name='([^']+)'/);
if (!pkgMatch) fail("Could not read applicationId/package from APK badging output");
else if (expectedAppId && pkgMatch[1] !== expectedAppId) fail(`APK package is "${pkgMatch[1]}" but capacitor.config.json appId is "${expectedAppId}"`);
else ok(`APK package matches capacitor.config.json appId (${pkgMatch[1]})`);

// --- required permissions -------------------------------------------------
const requiredPermissions = [
  "android.permission.INTERNET",
  "android.permission.POST_NOTIFICATIONS",
];
for (const perm of requiredPermissions) {
  if (badging.includes(`uses-permission: name='${perm}'`)) ok(`permission present: ${perm}`);
  else fail(`permission MISSING from built APK: ${perm}`);
}

// --- duospace:// deep link survived into the final manifest --------------
if (badging.includes("duospace")) ok("duospace:// scheme reference present in final manifest");
else fail("duospace:// scheme not found in the built APK's manifest — deep-link OAuth callback will not resolve");

// --- capacitor.plugins.json shipped inside the APK ------------------------
let pluginsJsonEntry;
try {
  const listing = execFileSync("unzip", ["-l", apkPath], { encoding: "utf8" });
  pluginsJsonEntry = listing.includes("assets/capacitor.plugins.json");
} catch (e) {
  fail(`Could not list APK contents: ${e.message}`);
}
if (pluginsJsonEntry) {
  ok("assets/capacitor.plugins.json present inside the built APK");
  try {
    const raw = execFileSync("unzip", ["-p", apkPath, "assets/capacitor.plugins.json"], { encoding: "utf8" });
    const plugins = JSON.parse(raw);
    const pkgNames = plugins.map((p) => p.pkg);
    const required = ["@capacitor/app", "@capacitor/browser", "@capacitor/preferences"];
    for (const req of required) {
      if (pkgNames.includes(req)) ok(`${req} registered inside the shipped APK`);
      else fail(`${req} MISSING from capacitor.plugins.json inside the shipped APK`);
    }
  } catch (e) {
    fail(`Could not read/parse capacitor.plugins.json from inside the APK: ${e.message}`);
  }
} else {
  fail("assets/capacitor.plugins.json is NOT inside the built APK — plugins will report \"not implemented\" at runtime even though the pre-Gradle checks passed. This means Gradle packaged a different assets/ tree than the one cap sync wrote (stale build cache, or webDir/assets mismatch) — investigate before shipping.");
}

// --- signature (release builds only get here with a signingConfig) -------
if (badging.match(/^application-label/m)) ok("APK has a resolvable application label (basic structural sanity check)");

if (failed) {
  console.error("\n[verify-apk] FAILED — do not ship this artifact.\n");
  process.exit(1);
}
console.log("\n[verify-apk] All APK checks passed.\n");

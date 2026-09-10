#!/usr/bin/env node
/**
 * apply-whitelabel.mjs
 *
 * Connects an app/project configured in Icon Studio (Settings → Appearance →
 * Icon Studio) to the actual native build. Icon Studio runs in the browser
 * and cannot write to the project filesystem directly, so the bridge is:
 *
 *   1. In Icon Studio, pick the app, design its icon, click
 *      "Export Android + iOS icon set" — downloads a zip.
 *   2. Unzip it and copy its resources/ folder to
 *      whitelabel/<appId>/resources/ in this repo (that's the only manual
 *      step; see whitelabel/README.md).
 *   3. Run:  node scripts/apply-whitelabel.mjs <appId>
 *
 * What this script does, in order:
 *   1. Reads whitelabel/apps.json for the app's name/packageId/bundleId.
 *      (Export this file from the Icon Studio app-picker's "Export config"
 *      action, or hand-edit it — see whitelabel/README.md. Falls back to a
 *      single seeded "duospace" entry matching capacitor.config.ts if the
 *      file doesn't exist yet.)
 *   2. Copies whitelabel/<appId>/resources/*.png over the root resources/
 *      folder (the source files @capacitor/assets reads).
 *   3. Patches capacitor.config.ts: appId, appName.
 *   4. If android/ exists (post `npx cap add android`): patches
 *      applicationId in android/app/build.gradle[.kts] and app_name in
 *      android/app/src/main/res/values/strings.xml.
 *   5. If ios/ exists (post `npx cap add ios`): patches CFBundleDisplayName
 *      + CFBundleName in Info.plist, and every PRODUCT_BUNDLE_IDENTIFIER in
 *      the Xcode project.
 *   6. Best-effort runs `npx @capacitor/assets generate` to regenerate every
 *      native icon size from the resources/ files just copied in. This step
 *      needs network + the native project to exist; if either is missing it
 *      logs exactly why and leaves the manually-provided android/ + ios/
 *      files from the exported zip in place as a fallback (drop them in
 *      directly per the zip's README.txt).
 *
 * Idempotent — safe to run repeatedly, and safe to run before android/ or
 * ios/ exist (those two steps just skip with a clear message, same
 * convention as scripts/patch-native-permissions.mjs — run this again after
 * `cap add`).
 *
 * NOT handled (out of scope for icon/name white-labeling): the OAuth deep
 * link scheme ("duospace://auth") is shared config wired through
 * src/lib/auth-redirect.ts + scripts/patch-native-permissions.mjs — every
 * white-label app built from this repo currently shares it. Splitting that
 * per-app is a separate, bigger change (each app would need its own OAuth
 * provider redirect URI registered) and isn't done here.
 *
 * Usage:
 *   node scripts/apply-whitelabel.mjs <appId>
 *   node scripts/apply-whitelabel.mjs --list
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const ROOT = process.cwd();
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
void SCRIPT_DIR; // reserved for future use (native/ template copies, mirrors patch-native-permissions.mjs)

const APPS_JSON = join(ROOT, "whitelabel", "apps.json");
const CAPACITOR_CONFIG = join(ROOT, "capacitor.config.ts");
const RESOURCES_DIR = join(ROOT, "resources");

const DEFAULT_APPS = [
  { id: "duospace", name: "DuoSpace", packageId: "com.duospace.app", bundleId: "com.duospace.app" },
];

function loadApps() {
  if (!existsSync(APPS_JSON)) {
    console.log(`[apply-whitelabel] ${APPS_JSON} not found — using the built-in default app record (id: "duospace").`);
    console.log(`[apply-whitelabel] Export your real config from Icon Studio's app picker to replace this.`);
    return DEFAULT_APPS;
  }
  try {
    const parsed = JSON.parse(readFileSync(APPS_JSON, "utf8"));
    if (!Array.isArray(parsed) || !parsed.length) throw new Error("empty or not an array");
    return parsed;
  } catch (err) {
    console.error(`[apply-whitelabel] Could not parse ${APPS_JSON}: ${err.message}`);
    process.exit(1);
  }
}

function log(step, msg) { console.log(`[apply-whitelabel] ${step}: ${msg}`); }
function warn(step, msg) { console.warn(`[apply-whitelabel] ${step}: ${msg}`); }

// ---- 1. resolve the requested app ----
const args = process.argv.slice(2);
const apps = loadApps();

if (args.includes("--list") || args.length === 0) {
  console.log("Registered white-label apps:");
  for (const a of apps) console.log(`  ${a.id}  ${a.name}  (${a.packageId})`);
  if (args.length === 0) {
    console.log("\nUsage: node scripts/apply-whitelabel.mjs <appId>");
    process.exit(apps.length ? 0 : 1);
  }
  process.exit(0);
}

const appId = args[0];
const app = apps.find(a => a.id === appId);
if (!app) {
  console.error(`[apply-whitelabel] No app with id "${appId}" in ${APPS_JSON}. Run with --list to see available ids.`);
  process.exit(1);
}
log("app", `${app.name}  packageId=${app.packageId}  bundleId=${app.bundleId || app.packageId}`);
const bundleId = app.bundleId || app.packageId;

// ---- 2. copy icon resources ----
const appResourcesDir = join(ROOT, "whitelabel", app.id, "resources");
const RESOURCE_FILES = ["icon.png", "icon-foreground.png", "icon-background.png", "icon-monochrome.png"];
if (existsSync(appResourcesDir)) {
  mkdirSync(RESOURCES_DIR, { recursive: true });
  let copied = 0;
  for (const file of RESOURCE_FILES) {
    const src = join(appResourcesDir, file);
    if (!existsSync(src)) { warn("resources", `${file} missing in ${appResourcesDir} — skipping that file.`); continue; }
    copyFileSync(src, join(RESOURCES_DIR, file));
    copied++;
  }
  log("resources", `copied ${copied}/${RESOURCE_FILES.length} files from ${appResourcesDir} into resources/`);
} else {
  warn("resources", `${appResourcesDir} not found — icon unchanged. Export the icon set from Icon Studio for "${app.name}" and unzip its resources/ folder there first.`);
}

// ---- 3. capacitor.config.ts ----
if (existsSync(CAPACITOR_CONFIG)) {
  let cfg = readFileSync(CAPACITOR_CONFIG, "utf8");
  const before = cfg;
  cfg = cfg.replace(/appId:\s*'[^']*'/, `appId: '${app.packageId}'`);
  cfg = cfg.replace(/appName:\s*'[^']*'/, `appName: '${app.name}'`);
  if (cfg !== before) {
    writeFileSync(CAPACITOR_CONFIG, cfg);
    log("capacitor.config.ts", `set appId="${app.packageId}", appName="${app.name}"`);
  } else {
    log("capacitor.config.ts", "already up to date");
  }
} else {
  warn("capacitor.config.ts", "not found — skipping (unexpected; this file should be at the project root).");
}

// ---- 4. Android ----
const ANDROID_BUILD_GRADLE = [join(ROOT, "android", "app", "build.gradle"), join(ROOT, "android", "app", "build.gradle.kts")]
  .find(existsSync);
const ANDROID_STRINGS = join(ROOT, "android", "app", "src", "main", "res", "values", "strings.xml");
const ANDROID_DIR = join(ROOT, "android");

if (existsSync(ANDROID_DIR)) {
  if (ANDROID_BUILD_GRADLE) {
    let gradle = readFileSync(ANDROID_BUILD_GRADLE, "utf8");
    const before = gradle;
    // applicationId "com.duospace.app"  OR  applicationId = "com.duospace.app" (kts)
    gradle = gradle.replace(/applicationId(\s*=)?\s*"[^"]*"/, `applicationId$1 "${app.packageId}"`);
    if (gradle !== before) {
      writeFileSync(ANDROID_BUILD_GRADLE, gradle);
      log("android/build.gradle", `set applicationId="${app.packageId}"`);
    } else {
      warn("android/build.gradle", 'could not find an applicationId "..." line to patch — set it manually.');
    }
  } else {
    warn("android", "app/build.gradle(.kts) not found under android/ — skipping applicationId patch.");
  }

  if (existsSync(ANDROID_STRINGS)) {
    let strings = readFileSync(ANDROID_STRINGS, "utf8");
    const before = strings;
    if (strings.includes('name="app_name"')) {
      strings = strings.replace(/(<string name="app_name">)[^<]*(<\/string>)/, `$1${app.name}$2`);
    } else {
      strings = strings.replace("<resources>", `<resources>\n    <string name="app_name">${app.name}</string>`);
    }
    if (strings !== before) {
      writeFileSync(ANDROID_STRINGS, strings);
      log("android/strings.xml", `set app_name="${app.name}"`);
    } else {
      log("android/strings.xml", "already up to date");
    }
  } else {
    warn("android/strings.xml", "not found — application label unchanged. Capacitor generates this on `npx cap add android`.");
  }
} else {
  warn("android", "android/ directory not found — run `npx cap add android` first, then re-run this script to set the app name/id/icon natively.");
}

// ---- 5. iOS ----
const IOS_DIR = join(ROOT, "ios");
const IOS_PLIST = join(ROOT, "ios", "App", "App", "Info.plist");
const IOS_PBXPROJ = join(ROOT, "ios", "App", "App.xcodeproj", "project.pbxproj");

if (existsSync(IOS_DIR)) {
  if (existsSync(IOS_PLIST)) {
    let plist = readFileSync(IOS_PLIST, "utf8");
    const before = plist;
    for (const key of ["CFBundleDisplayName", "CFBundleName"]) {
      const re = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`);
      if (re.test(plist)) {
        plist = plist.replace(re, `$1${app.name}$2`);
      } else {
        warn("ios/Info.plist", `no existing <key>${key}</key> entry found — add it manually (Capacitor normally generates it on \`npx cap add ios\`).`);
      }
    }
    if (plist !== before) {
      writeFileSync(IOS_PLIST, plist);
      log("ios/Info.plist", `set CFBundleDisplayName/CFBundleName="${app.name}"`);
    } else {
      log("ios/Info.plist", "already up to date");
    }
  } else {
    warn("ios/Info.plist", "not found — skipping display name patch.");
  }

  if (existsSync(IOS_PBXPROJ)) {
    let pbx = readFileSync(IOS_PBXPROJ, "utf8");
    const before = pbx;
    pbx = pbx.replace(/PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/g, `PRODUCT_BUNDLE_IDENTIFIER = ${bundleId};`);
    if (pbx !== before) {
      writeFileSync(IOS_PBXPROJ, pbx);
      log("ios/project.pbxproj", `set PRODUCT_BUNDLE_IDENTIFIER="${bundleId}" (all targets)`);
    } else {
      warn("ios/project.pbxproj", "no PRODUCT_BUNDLE_IDENTIFIER lines found to patch — set it manually in Xcode.");
    }
  } else {
    warn("ios/project.pbxproj", "not found — skipping bundle id patch.");
  }
} else {
  warn("ios", "ios/ directory not found — run `npx cap add ios` first, then re-run this script to set the app name/bundle id/icon natively.");
}

// ---- 6. regenerate native icon sizes from resources/ (best-effort) ----
if (existsSync(RESOURCES_DIR) && readdirSync(RESOURCES_DIR).some(f => f.startsWith("icon"))) {
  try {
    log("capacitor-assets", "running `npx @capacitor/assets generate`…");
    execSync("npx @capacitor/assets generate", { stdio: "inherit", cwd: ROOT, timeout: 120_000 });
    log("capacitor-assets", "done — native icon sizes regenerated from resources/.");
  } catch (err) {
    warn("capacitor-assets", `could not run automatically (${err.message.split("\n")[0]}). This needs the @capacitor/assets package and network access.`);
    warn("capacitor-assets", "Fallback: the icon set you exported from Icon Studio already contains every android/ and ios/ size pre-rendered — copy those folders in directly instead (see the zip's README.txt).");
  }
} else {
  warn("capacitor-assets", "no resources/icon*.png found — nothing to regenerate from. Export an icon from Icon Studio first.");
}

console.log(`\n[apply-whitelabel] Done for "${app.name}" (${appId}).`);

#!/usr/bin/env node
/**
 * verify-android-build.mjs
 *
 * Gate that must pass before Gradle ever runs. Two phases:
 *
 *   --deps    Pure package.json audit. No android/ project needed — safe to
 *             run at any time, including in CI before `npm install` even
 *             finishes talking to the network. Catches the single most
 *             common cause of "installs fine, launches fine, then breaks/
 *             crashes the moment you touch a specific native feature":
 *             a Capacitor plugin whose major version doesn't match
 *             @capacitor/core. Mismatched plugins often still *compile*
 *             (Gradle doesn't know they're incompatible) but crash the
 *             first time their native method is actually invoked, because
 *             the plugin's compiled code calls a Bridge/PluginCall API
 *             signature that changed between Capacitor majors. That crash
 *             happens on the native side, so it can't be caught by a JS
 *             try/catch around the call.
 *
 *   --native  Post `cap add android` + `cap sync` + `patch-native-permissions`.
 *             Verifies the generated android/ project actually has what it's
 *             supposed to: launcher Activity singleTask, both duospace://
 *             deep-link hosts, the FCM call services, MainActivity's
 *             lifecycle hooks, and — critically — that capacitor.plugins.json
 *             actually lists every plugin the app depends on. This is the
 *             direct, mechanical answer to "is the Browser plugin actually
 *             registered in this APK", checked from the generated file
 *             instead of guessed at.
 *
 *   (no flag) Runs --deps, then --native if android/ exists yet.
 *
 * Exit code is non-zero on any failure — wire this into the build pipeline
 * BEFORE the Gradle step so a broken plugin/manifest/deep-link fails fast
 * with a specific message instead of surfacing as a runtime crash on a
 * device three steps later.
 *
 * Usage:
 *   node scripts/verify-android-build.mjs --deps
 *   node scripts/verify-android-build.mjs --native
 *   node scripts/verify-android-build.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
let failed = false;

const fail = (msg) => { console.error(`[verify-android-build] \u274c ${msg}`); failed = true; };
const ok = (msg) => console.log(`[verify-android-build] \u2705 ${msg}`);

function majorOf(range) {
  const m = String(range || "").match(/(\d+)/);
  return m ? m[1] : null;
}

function checkDeps() {
  console.log("\n--- Dependency compatibility ---");
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const coreRange = pkg.dependencies?.["@capacitor/core"];
  if (!coreRange) { fail("@capacitor/core not found in dependencies"); return; }
  const coreMajor = majorOf(coreRange);
  if (!coreMajor) { fail(`Could not parse a major version from @capacitor/core range "${coreRange}"`); return; }
  ok(`@capacitor/core is Capacitor ${coreMajor}.x (${coreRange})`);

  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  const capPackages = Object.keys(allDeps).filter(
    (name) => (name.startsWith("@capacitor/") || name.startsWith("@capacitor-community/")) && name !== "@capacitor/core",
  );
  for (const name of capPackages) {
    const range = allDeps[name];
    const major = majorOf(range);
    if (!major) { fail(`${name}@${range} — could not parse a major version, verify manually`); continue; }
    if (major !== coreMajor) {
      fail(
        `${name}@${range} is Capacitor ${major}.x but @capacitor/core is ${coreMajor}.x. ` +
        `This will likely still build, then crash or silently fail to register the moment ` +
        `its native method is called. Bump ${name} to ^${coreMajor}.0.0.`,
      );
    } else {
      ok(`${name}@${range} matches core major ${coreMajor}`);
    }
  }

  // Local file: plugins (native-plugins/*) — confirm they actually exist,
  // declare Capacitor's plugin metadata, and target the same core major.
  for (const [name, range] of Object.entries(pkg.dependencies || {})) {
    if (!range.startsWith("file:")) continue;
    const pluginDir = join(ROOT, range.replace("file:", ""));
    const pluginPkgPath = join(pluginDir, "package.json");
    if (!existsSync(pluginPkgPath)) { fail(`${name} points to "${range}" but ${pluginPkgPath} does not exist`); continue; }
    const pluginPkg = JSON.parse(readFileSync(pluginPkgPath, "utf8"));
    if (!pluginPkg.capacitor) {
      fail(`${name} (${range}) has no "capacitor" field in its package.json — cap sync will not detect it as a plugin`);
      continue;
    }
    const peerRange = pluginPkg.peerDependencies?.["@capacitor/core"];
    const peerMajor = majorOf(peerRange);
    if (peerMajor && peerMajor !== coreMajor) {
      fail(`${name} declares peerDependency @capacitor/core ${peerRange}, app uses ${coreMajor}.x`);
    } else {
      ok(`${name} (local plugin) OK — android src="${pluginPkg.capacitor?.android?.src ?? "(none)"}"`);
    }
  }
}

function checkNative() {
  console.log("\n--- Generated native project ---");
  const manifestPath = join(ROOT, "android", "app", "src", "main", "AndroidManifest.xml");
  if (!existsSync(manifestPath)) {
    console.log("[verify-android-build] android/ not generated yet — skipping native checks. Run after `cap add android` + `cap sync` + `cap:patch-permissions`.");
    return;
  }
  const manifest = readFileSync(manifestPath, "utf8");

  const manifestChecks = [
    ['android:launchMode="singleTask"', "launcher Activity uses singleTask (without this, the OAuth callback recreates the Activity — the app appears to terminate/restart)"],
    ['android:scheme="duospace"', 'duospace:// scheme registered'],
    ['android:host="auth"', 'duospace://auth intent-filter present (OAuth callback)'],
    ['android:host="call"', 'duospace://call intent-filter present (call notification actions)'],
    ['.CallNotificationService"', "CallNotificationService registered"],
    ['.CallRingingService"', "CallRingingService registered"],
    ['.DuoSpaceConnectionService"', "DuoSpaceConnectionService (Telecom) registered"],
    ['android.telecom.ConnectionService', "ConnectionService intent-filter action present"],
    ['android.permission.MANAGE_OWN_CALLS', "MANAGE_OWN_CALLS permission declared"],
  ];
  for (const [needle, label] of manifestChecks) {
    if (manifest.includes(needle)) ok(label);
    else fail(`AndroidManifest.xml missing: ${label}`);
  }

  const mainActivityKt = join(ROOT, "android", "app", "src", "main", "java", "com", "duospace", "app", "MainActivity.kt");
  if (existsSync(mainActivityKt)) {
    const src = readFileSync(mainActivityKt, "utf8");
    if (!/class MainActivity\s*:\s*BridgeActivity\s*\(\s*\)/.test(src)) {
      fail("MainActivity.kt does not extend BridgeActivity()");
    } else {
      ok("MainActivity extends BridgeActivity");
    }
    if (src.includes("DUOSPACE PUSH ADDITIONS")) ok("MainActivity has the push/OAuth lifecycle hooks");
    else fail("MainActivity missing push/OAuth lifecycle hooks — run `npm run cap:patch-permissions`");
    if (src.includes("TelecomHelper.registerPhoneAccount")) ok("MainActivity registers the self-managed PhoneAccount on startup");
    else fail("MainActivity missing TelecomHelper.registerPhoneAccount() call — run `npm run cap:patch-permissions`");
  } else {
    fail("MainActivity.kt not found — run `npx cap add android`");
  }

  const telecomFiles = ["TelecomHelper.kt", "CallBridge.kt", "DuoSpaceConnection.kt", "DuoSpaceConnectionService.kt"];
  for (const f of telecomFiles) {
    const p = join(ROOT, "android", "app", "src", "main", "java", "com", "duospace", "app", f);
    if (existsSync(p)) ok(`${f} present in generated project`);
    else fail(`${f} missing from android/app/src/main/java/com/duospace/app/ — run \`npm run cap:patch-permissions\``);
  }

  const pluginsJson = join(ROOT, "android", "app", "src", "main", "assets", "capacitor.plugins.json");
  if (!existsSync(pluginsJson)) {
    fail("capacitor.plugins.json not found in android/app/src/main/assets — `cap sync` did not run, or failed silently");
  } else {
    const plugins = JSON.parse(readFileSync(pluginsJson, "utf8"));
    const pkgNames = plugins.map((p) => p.pkg);

    // Derived from package.json, not hand-maintained — a hardcoded list
    // drifts the moment a plugin is added/removed and silently stops
    // covering it. Every @capacitor/*, @capacitor-community/*, @capawesome/*,
    // and local file:-linked plugin the app actually depends on must be
    // registered; core/cli/android/ios themselves aren't plugins.
    const pkgJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const nonPluginPackages = new Set(["@capacitor/core", "@capacitor/cli", "@capacitor/android", "@capacitor/ios"]);
    const required = Object.keys(pkgJson.dependencies || {}).filter(
      (name) =>
        !nonPluginPackages.has(name) &&
        (name.startsWith("@capacitor/") ||
          name.startsWith("@capacitor-community/") ||
          name.startsWith("@capawesome/") ||
          (pkgJson.dependencies[name] || "").startsWith("file:")),
    );
    for (const req of required) {
      if (pkgNames.includes(req)) ok(`${req} registered in capacitor.plugins.json`);
      else fail(`${req} MISSING from capacitor.plugins.json — will fail at runtime with "<Plugin> is not implemented on android"`);
    }

    // FIX: capacitor.plugins.json (checked above) is the JS-bridge-side
    // manifest — it tells the WebView which plugin classes to look for. It
    // does NOT prove those classes actually got *compiled into the APK*.
    // That's a separate file, android/capacitor.settings.gradle (also
    // regenerated by `cap sync`, alongside android/settings.gradle's
    // `apply from: 'capacitor.settings.gradle'` include of it) — if that
    // include line is missing (e.g. a hand-edited settings.gradle for some
    // other customization dropped it) or capacitor.settings.gradle itself
    // is stale/didn't regenerate, a plugin can be present in
    // capacitor.plugins.json (so the check above passes) while its actual
    // class is absent from the build — Capacitor's bridge then logs
    // "Unable to register plugin instance" / ClassNotFoundException at
    // runtime, on-device, for exactly that plugin — Preferences has been
    // reported doing this. Neither the JSON check above nor a green Gradle
    // build catches that on its own, since Gradle doesn't know a *missing*
    // module was ever supposed to exist.
    const settingsGradlePath = join(ROOT, "android", "settings.gradle");
    const capSettingsGradlePath = join(ROOT, "android", "capacitor.settings.gradle");
    if (!existsSync(settingsGradlePath)) {
      fail("android/settings.gradle not found — cap sync did not run, or failed silently");
    } else {
      const settingsGradle = readFileSync(settingsGradlePath, "utf8");
      if (!/apply from:\s*['"]capacitor\.settings\.gradle['"]/.test(settingsGradle)) {
        fail(
          "android/settings.gradle does not `apply from: 'capacitor.settings.gradle'` — every native " +
          "plugin module (including Preferences) is silently excluded from the build even though " +
          "capacitor.plugins.json still lists it. This is the single most common cause of a plugin " +
          "\"failing to register\" specifically on Android while the JS side looks correctly wired. " +
          "Re-run `npx cap sync android`, or if settings.gradle was hand-edited, add that line back.",
        );
      } else {
        ok("android/settings.gradle applies capacitor.settings.gradle");
      }
    }
    if (!existsSync(capSettingsGradlePath)) {
      fail("android/capacitor.settings.gradle not found — cap sync did not run, or failed silently");
    } else {
      const capSettingsGradle = readFileSync(capSettingsGradlePath, "utf8");
      for (const req of required) {
        // The generated projectDir line always embeds the exact npm package
        // path, e.g. `new File('../node_modules/@capacitor/preferences/android')`
        // — checking for that substring doesn't require guessing Capacitor's
        // internal Gradle-module-id naming scheme, just that the package is
        // wired in at all.
        if (capSettingsGradle.includes(`node_modules/${req}`)) {
          ok(`${req} has a Gradle module wired in android/capacitor.settings.gradle`);
        } else {
          fail(
            `${req} is missing from android/capacitor.settings.gradle (no node_modules/${req} projectDir entry) — ` +
            `its class will not be compiled into the APK even if capacitor.plugins.json lists it. Run \`npx cap sync android\`.`,
          );
        }
      }
    }
  }
}

const mode = process.argv[2];
console.log("=== Android build gate (scripts/verify-android-build.mjs) ===");
if (mode === "--deps") checkDeps();
else if (mode === "--native") checkNative();
else { checkDeps(); checkNative(); }

if (failed) {
  console.error("\n[verify-android-build] FAILED \u2014 fix the issues above before running Gradle.\n");
  process.exit(1);
}
console.log("\n[verify-android-build] All checks passed.\n");

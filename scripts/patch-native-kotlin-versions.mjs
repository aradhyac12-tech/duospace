#!/usr/bin/env node
/**
 * patch-native-kotlin-versions.mjs
 *
 * ------------------------------------------------------------------
 * WHY THIS FILE EXISTS (updated after the 2026-09-06 APKForge build)
 * ------------------------------------------------------------------
 *
 * Previous state: the earlier version of this script forced
 * kotlin-stdlib / kotlinx-coroutines-* down to metadata <= 2.0.0 inside
 * @capacitor/{camera,filesystem,geolocation}. That fix WORKED for
 * filesystem and geolocation — both compiled cleanly in the latest build.
 *
 * Remaining failure (the only thing that broke the 2026-09-06 build):
 *
 *   > Task :capacitor-camera:compileReleaseKotlin FAILED
 *   e: CameraPlugin.kt:34:30 Cannot access 'CAMERA': it is private in 'Companion'
 *   e: CameraPlugin.kt:37:30 Cannot access 'PHOTOS': it is private in 'Companion'
 *   e: CameraPlugin.kt:40:30 Cannot access 'SAVE_GALLERY': it is private in 'Companion'
 *   e: CameraPlugin.kt:43:30 Cannot access 'READ_EXTERNAL_STORAGE': it is private in 'Companion'
 *   e: IonCameraFlow.kt:540:46 Type mismatch: inferred type is Intent? but Intent was expected
 *
 * These are NOT metadata/classpath errors — they are *language-level*
 * errors. @capacitor/camera 8.2.x source is written against Kotlin 2.x
 * semantics:
 *
 *   1. `@CapacitorPlugin(permissions = [Permission(alias = CameraPlugin.CAMERA)])`
 *      references `private const val` members of the class's own companion
 *      from the class's annotation. Kotlin 2.x allows it; the 1.9.x
 *      frontend rejects it as a private access.
 *   2. `IonCameraFlow.kt` relies on K2's improved smart-casting of a
 *      reassigned local `var intent: Intent?` — the 1.9 frontend does not
 *      narrow it and reports Intent? vs Intent.
 *
 * The compiler is 1.9.25 because APKForge's NATIVE_MODULE_COMPILE step
 * back-fills `classpath "org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25"`
 * into the generated root android/build.gradle whenever that file does not
 * already mention "kotlin-gradle-plugin" — which the stock Capacitor 8.5
 * android template never does.
 *
 * ------------------------------------------------------------------
 * WHAT THIS VERSION DOES (three independent layers)
 * ------------------------------------------------------------------
 *
 * Layer 1 (primary, deterministic): patch the camera plugin's Kotlin
 *   sources in node_modules so they compile under BOTH 1.9.x and 2.x:
 *   drop `private` from the four companion permission aliases, and make
 *   the IonCameraFlow Intent non-null explicitly. Small, idempotent, and
 *   independent of which compiler ends up applied. This alone unblocks
 *   the build.
 *
 * Layer 2 (kept unchanged, still required): the per-module
 *   resolutionStrategy force block that pins kotlin-stdlib /
 *   kotlinx-coroutines-* to metadata <= 2.0.0. This is what makes
 *   filesystem/geolocation compile under 1.9.25 and is deliberately NOT
 *   raised — an older stdlib read by a newer compiler is always fine, so
 *   these pins are safe under 2.1 as well.
 *
 * Layer 3 (best effort, removes the root cause): rewrite the Capacitor
 *   CLI's android-template tarball so the generated root
 *   android/build.gradle already declares kotlin-gradle-plugin 2.1.0.
 *   When this lands, APKForge's 1.9.25 back-fill is skipped (its own
 *   condition is "file doesn't mention kotlin-gradle-plugin") and the
 *   whole project compiles on Kotlin 2.1. Requires `tar` on PATH; if it
 *   is unavailable or the asset layout changes, we log and move on —
 *   Layers 1 and 2 already keep the build green.
 *   An already-generated android/build.gradle is patched in place too.
 *
 * Runs as package.json "postinstall", i.e. right after install and well
 * before `cap add android` / `cap sync`. Idempotent; every target is
 * skipped with a clear message when missing or already patched.
 */

import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const LOG = "[patch-native-kotlin-versions]";
const log = (msg) => console.log(`${LOG} ${msg}`);

const KOTLIN_VERSION = "2.1.0";

const FORCED_VERSIONS = {
  "org.jetbrains.kotlin:kotlin-stdlib": "1.9.25",
  "org.jetbrains.kotlin:kotlin-stdlib-jdk7": "1.9.25",
  "org.jetbrains.kotlin:kotlin-stdlib-jdk8": "1.9.25",
  "org.jetbrains.kotlin:kotlin-stdlib-common": "1.9.25",
  "org.jetbrains.kotlinx:kotlinx-coroutines-core": "1.8.1",
  "org.jetbrains.kotlinx:kotlinx-coroutines-core-jvm": "1.8.1",
  "org.jetbrains.kotlinx:kotlinx-coroutines-android": "1.8.1",
  "org.jetbrains.kotlinx:kotlinx-coroutines-play-services": "1.8.1",
};

const TARGETS = ["@capacitor/camera", "@capacitor/filesystem", "@capacitor/geolocation"];

const MARKER = "PATCHED by scripts/patch-native-kotlin-versions.mjs";

const BUILDSCRIPT_BLOCK = `// ---- ${MARKER} ----
// Local Kotlin Gradle Plugin override — belt-and-suspenders only; the
// mechanisms that actually fix the build are the resolutionStrategy force
// block below and the Kotlin source patches applied to @capacitor/camera.
buildscript {
    ext.kotlinVersion = project.hasProperty('kotlinVersion') ? rootProject.ext.kotlinVersion : '${KOTLIN_VERSION}'
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath "org.jetbrains.kotlin:kotlin-gradle-plugin:$kotlinVersion"
    }
}
// ---- end patch ----

`;

const FORCE_BLOCK = `
// ---- ${MARKER} (resolutionStrategy) ----
// Force kotlin-stdlib / kotlinx-coroutines-* down to versions whose own
// Kotlin metadata is <= 2.0.0, so this module's compileReleaseKotlin
// succeeds regardless of which Kotlin Gradle Plugin version the CI ends up
// applying (1.9.25 fallback, or 2.1.0 once the template patch lands).
configurations.all {
    resolutionStrategy {
        force(
${Object.entries(FORCED_VERSIONS)
  .map(([module, version]) => `            "${module}:${version}"`)
  .join(",\n")}
        )
    }
}
// ---- end patch ----
`;

/* ------------------------------------------------------------------ */
/* Layer 2: per-module Gradle patches (unchanged behaviour)            */
/* ------------------------------------------------------------------ */

function patchModuleGradle(pkg) {
  const gradlePath = join(ROOT, "node_modules", pkg, "android", "build.gradle");
  if (!existsSync(gradlePath)) {
    log(`Skipping ${pkg} — ${gradlePath} not found (not installed yet?).`);
    return;
  }
  const original = readFileSync(gradlePath, "utf8");
  if (original.includes(MARKER)) {
    log(`${pkg} build.gradle already patched — skipping.`);
    return;
  }
  writeFileSync(gradlePath, BUILDSCRIPT_BLOCK + original + "\n" + FORCE_BLOCK, "utf8");
  log(`Patched ${pkg} build.gradle — forced kotlin-stdlib/kotlinx-coroutines-* to Kotlin-1.9-readable versions.`);
}

/* ------------------------------------------------------------------ */
/* Layer 1: @capacitor/camera Kotlin source patches                    */
/* ------------------------------------------------------------------ */

const CAMERA_SRC = join(
  ROOT,
  "node_modules",
  "@capacitor",
  "camera",
  "android",
  "src",
  "main",
  "java",
  "com",
  "capacitorjs",
  "plugins",
  "camera",
);

function patchCameraCompanionVisibility() {
  const file = join(CAMERA_SRC, "CameraPlugin.kt");
  if (!existsSync(file)) {
    log("Skipping CameraPlugin.kt — file not found (camera plugin not installed, or layout changed).");
    return;
  }
  const original = readFileSync(file, "utf8");
  if (original.includes(MARKER)) {
    log("CameraPlugin.kt already patched — skipping.");
    return;
  }

  // `@CapacitorPlugin(permissions = [Permission(alias = CameraPlugin.CAMERA)])`
  // reads these from outside the companion's private scope. Kotlin 2.x
  // permits it; 1.9.x rejects it. Making them public consts is source- and
  // binary-compatible and changes no runtime behaviour.
  const ALIASES = ["CAMERA", "PHOTOS", "SAVE_GALLERY", "READ_EXTERNAL_STORAGE"];
  let patched = original;
  let changed = 0;
  for (const alias of ALIASES) {
    const re = new RegExp(`private\\s+const\\s+val\\s+${alias}\\b`, "g");
    if (re.test(patched)) {
      patched = patched.replace(re, `const val ${alias}`);
      changed += 1;
    }
  }

  if (changed === 0) {
    log("CameraPlugin.kt — no `private const val` permission aliases found; upstream may have fixed this already. Leaving untouched.");
    return;
  }

  patched = `// ---- ${MARKER} ----\n` +
    `// Companion permission aliases made non-private: they are referenced from\n` +
    `// the class-level @CapacitorPlugin annotation, which a Kotlin 1.9.x\n` +
    `// frontend rejects ("Cannot access 'CAMERA': it is private in 'Companion'").\n` +
    `// ---- end patch ----\n` +
    patched;

  writeFileSync(file, patched, "utf8");
  log(`Patched CameraPlugin.kt — ${changed} companion permission alias(es) made non-private.`);
}

function patchCameraIntentNullability() {
  const file = join(CAMERA_SRC, "IonCameraFlow.kt");
  if (!existsSync(file)) {
    log("Skipping IonCameraFlow.kt — file not found (camera plugin not installed, or layout changed).");
    return;
  }
  const original = readFileSync(file, "utf8");
  if (original.includes(MARKER)) {
    log("IonCameraFlow.kt already patched — skipping.");
    return;
  }

  // Upstream shape (RESULT_OK branch):
  //     var intent = result.data                    // Intent?
  //     ...
  //     if (resultPath.isNullOrEmpty()) { ... intent = Intent().apply { ... } }
  //     processResultEditFromGallery(intent)        // needs Intent
  //
  // K2 smart-casts this to non-null; 1.9.x does not. `intent` is provably
  // non-null at the call site (either result.data carried the output URI,
  // or the branch above assigned a fresh Intent, or we already returned),
  // so an explicit !! is correct rather than merely silencing.
  // Only the call site whose nearest preceding declaration is the nullable
  // `var intent = result.data` needs the assertion. The sibling branch
  // declares its own `val intent = Intent()` (already non-null) and must be
  // left alone, otherwise Kotlin emits an "unnecessary non-null assertion"
  // warning there.
  const lines = original.split("\n");
  let nullableIntentInScope = false;
  let changed = 0;
  const out = lines.map((line) => {
    if (/\bvar\s+intent\s*=\s*result\.data\b/.test(line)) nullableIntentInScope = true;
    else if (/\bval\s+intent\s*=\s*Intent\(\)/.test(line)) nullableIntentInScope = false;

    if (nullableIntentInScope && /processResultEditFromGallery\(intent\)/.test(line)) {
      changed += 1;
      nullableIntentInScope = false;
      return line.replace("processResultEditFromGallery(intent)", "processResultEditFromGallery(intent!!)");
    }
    return line;
  });

  if (changed === 0) {
    log("IonCameraFlow.kt — nullable `processResultEditFromGallery(intent)` call not found; upstream may have fixed this already. Leaving untouched.");
    return;
  }

  const patched =
    `// ---- ${MARKER} ----\n` +
    `// Explicit non-null assertion on a value Kotlin 2.x smart-casts but the\n` +
    `// 1.9.x frontend does not ("inferred type is Intent? but Intent was\n` +
    `// expected"). The value is provably non-null at this call site.\n` +
    `// ---- end patch ----\n` +
    out.join("\n");

  writeFileSync(file, patched, "utf8");
  log(`Patched IonCameraFlow.kt — ${changed} Intent? call site(s) made explicitly non-null.`);
}

/* ------------------------------------------------------------------ */
/* Layer 3: root android/build.gradle + CLI android-template tarball   */
/* ------------------------------------------------------------------ */

const ROOT_GRADLE_KOTLIN_PATCH = (contents) => {
  if (/kotlin-gradle-plugin/.test(contents)) return null; // nothing to do
  let out = contents.replace(
    /buildscript\s*\{[ \t]*\n/,
    `buildscript {\n    ext.kotlin_version = '${KOTLIN_VERSION}'\n`,
  );

  out = out.replace(
    /(dependencies\s*\{\s*\n)/,
    `$1        // ---- ${MARKER} ----\n` +
      `        // Declare the Kotlin Gradle Plugin explicitly so CI does not\n` +
      `        // back-fill a stale 1.9.25 classpath (which cannot compile\n` +
      `        // Capacitor 8.x plugin sources written for Kotlin 2.x).\n` +
      `        classpath "org.jetbrains.kotlin:kotlin-gradle-plugin:${KOTLIN_VERSION}"\n`,
  );
  return out === contents ? null : out;
};

function patchGeneratedRootGradle() {
  const file = join(ROOT, "android", "build.gradle");
  if (!existsSync(file)) {
    log("No android/build.gradle yet (generated later by `cap add android`) — template patch below covers it.");
    return;
  }
  const original = readFileSync(file, "utf8");
  const patched = ROOT_GRADLE_KOTLIN_PATCH(original);
  if (!patched) {
    log("android/build.gradle already declares a Kotlin Gradle Plugin — skipping.");
    return;
  }
  writeFileSync(file, patched, "utf8");
  log(`Patched android/build.gradle — pinned kotlin-gradle-plugin ${KOTLIN_VERSION}.`);
}

function patchCliAndroidTemplate() {
  const asset = join(ROOT, "node_modules", "@capacitor", "cli", "assets", "android-template.tar.gz");
  if (!existsSync(asset)) {
    log("Skipping CLI android-template patch — assets/android-template.tar.gz not found.");
    return;
  }

  let work;
  try {
    execFileSync("tar", ["--version"], { stdio: "ignore" });
  } catch {
    log("Skipping CLI android-template patch — `tar` is not available on PATH. Layers 1 and 2 still apply.");
    return;
  }

  try {
    work = mkdtempSync(join(tmpdir(), "cap-android-template-"));
    execFileSync("tar", ["xzf", asset, "-C", work], { stdio: "ignore" });

    const gradleFile = join(work, "build.gradle");
    if (!existsSync(gradleFile)) {
      log("Skipping CLI android-template patch — build.gradle not found inside the template.");
      return;
    }
    const original = readFileSync(gradleFile, "utf8");
    const patched = ROOT_GRADLE_KOTLIN_PATCH(original);
    if (!patched) {
      log("CLI android-template already declares a Kotlin Gradle Plugin — skipping.");
      return;
    }
    writeFileSync(gradleFile, patched, "utf8");
    execFileSync("tar", ["czf", asset, "-C", work, "."], { stdio: "ignore" });
    log(`Patched @capacitor/cli android-template — generated projects now pin kotlin-gradle-plugin ${KOTLIN_VERSION}.`);
  } catch (error) {
    log(`CLI android-template patch failed (non-fatal): ${error?.message ?? error}`);
  } finally {
    if (work) rmSync(work, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */

for (const pkg of TARGETS) patchModuleGradle(pkg);
patchCameraCompanionVisibility();
patchCameraIntentNullability();
patchGeneratedRootGradle();
patchCliAndroidTemplate();

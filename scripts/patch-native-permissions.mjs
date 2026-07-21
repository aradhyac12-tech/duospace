#!/usr/bin/env node
/**
 * patch-native-permissions.mjs
 *
 * Two things this fixes on a fresh `npx cap add ios` / `npx cap add android`,
 * neither of which Capacitor generates on its own:
 *
 * 1) Camera/mic/photo usage-description strings. Without them:
 *   - iOS: WKWebView's getUserMedia() is auto-denied by the OS with
 *     `NotAllowedError: Permission denied` — no system prompt ever appears,
 *     because iOS refuses to show a camera/mic permission dialog at all
 *     unless NSCameraUsageDescription / NSMicrophoneUsageDescription exist
 *     in Info.plist. It fails silently and instantly.
 *   - Android: same failure mode if CAMERA/RECORD_AUDIO are ever missing
 *     from AndroidManifest.xml (normally auto-merged by the Capacitor
 *     camera plugin, but a `cap sync` skip or manual manifest edit can
 *     drop the merge).
 *
 * 2) The `duospace://auth` OAuth deep link. This is NOT the same as
 *   Capacitor's `ios.scheme` / `androidScheme` config (those only control
 *   how the WebView loads local app pages) — it's a separate, real OS-level
 *   URL scheme registration that only native project files can declare:
 *   - iOS: a CFBundleURLTypes entry in Info.plist.
 *   - Android: an <intent-filter> with android:scheme="duospace" on the
 *     launcher Activity in AndroidManifest.xml.
 *   Without this, `Browser.open()` successfully sends the user to Google's
 *   consent screen, but the system has nowhere to send them back to after
 *   they approve — the OAuth callback silently goes nowhere instead of
 *   returning to the app.
 *
 * This script is idempotent — safe to run repeatedly, and safe to run
 * before the native projects exist (it just skips with a clear message).
 * Run it after every `cap add` and every `cap sync`.
 *
 * Usage:
 *   node scripts/patch-native-permissions.mjs
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

const IOS_PLIST = join(ROOT, "ios", "App", "App", "Info.plist");
const ANDROID_MANIFEST = join(ROOT, "android", "app", "src", "main", "AndroidManifest.xml");

// Must match NATIVE_OAUTH_REDIRECT_URI in src/lib/auth-redirect.ts exactly.
const OAUTH_SCHEME = "duospace";
const OAUTH_HOST = "auth";

const IOS_KEYS = [
  ["NSCameraUsageDescription", "DuoSpace needs camera access to scan sign-in QR codes and take photos/video."],
  ["NSMicrophoneUsageDescription", "DuoSpace needs microphone access for voice and video calls."],
  ["NSPhotoLibraryUsageDescription", "DuoSpace needs access to your photo library to save and share photos."],
  ["NSPhotoLibraryAddUsageDescription", "DuoSpace needs permission to save photos to your library."],
  ["NSFaceIDUsageDescription", "DuoSpace uses Face ID to keep your conversations private."],
];

const ANDROID_PERMISSIONS = [
  "android.permission.CAMERA",
  "android.permission.RECORD_AUDIO",
  "android.permission.INTERNET",
];

function insertBeforeLastCloseDict(plist, entry) {
  const closeIdx = plist.lastIndexOf("</dict>");
  if (closeIdx === -1) return null;
  return plist.slice(0, closeIdx) + entry + plist.slice(closeIdx);
}

function patchIosPlist() {
  if (!existsSync(IOS_PLIST)) {
    console.log("[patch-native-permissions] Skipping iOS — ios/App/App/Info.plist not found (run `npx cap add ios` first).");
    return;
  }
  let plist = readFileSync(IOS_PLIST, "utf8");
  let changed = false;

  for (const [key, description] of IOS_KEYS) {
    if (plist.includes(`<key>${key}</key>`)) continue; // already present — don't clobber a customized description
    const entry = `\t<key>${key}</key>\n\t<string>${description}</string>\n`;
    const patched = insertBeforeLastCloseDict(plist, entry);
    if (!patched) {
      console.warn(`[patch-native-permissions] Could not find </dict> in Info.plist — skipping ${key}. Add it manually.`);
      continue;
    }
    plist = patched;
    changed = true;
    console.log(`[patch-native-permissions] iOS: added ${key}`);
  }

  // OAuth deep link: CFBundleURLTypes / CFBundleURLSchemes = [duospace].
  // Check for the specific scheme string, not just "CFBundleURLTypes",
  // since another plugin (or a prior manual edit) may have already added a
  // URL types array for something unrelated — we still need our own entry.
  if (!plist.includes(`<string>${OAUTH_SCHEME}</string>`)) {
    const urlTypesEntry =
      `\t<key>CFBundleURLTypes</key>\n` +
      `\t<array>\n` +
      `\t\t<dict>\n` +
      `\t\t\t<key>CFBundleURLName</key>\n` +
      `\t\t\t<string>com.duospace.app.oauth</string>\n` +
      `\t\t\t<key>CFBundleURLSchemes</key>\n` +
      `\t\t\t<array>\n` +
      `\t\t\t\t<string>${OAUTH_SCHEME}</string>\n` +
      `\t\t\t</array>\n` +
      `\t\t</dict>\n` +
      `\t</array>\n`;
    const patched = insertBeforeLastCloseDict(plist, urlTypesEntry);
    if (!patched) {
      console.warn("[patch-native-permissions] Could not find </dict> in Info.plist — add CFBundleURLTypes manually.");
    } else {
      plist = patched;
      changed = true;
      console.log(`[patch-native-permissions] iOS: added CFBundleURLTypes for ${OAUTH_SCHEME}:// deep link`);
    }
  }

  if (changed) {
    writeFileSync(IOS_PLIST, plist, "utf8");
    console.log("[patch-native-permissions] iOS Info.plist updated.");
  } else {
    console.log("[patch-native-permissions] iOS Info.plist already has all required usage descriptions and the OAuth deep link.");
  }
}

function patchAndroidManifest() {
  if (!existsSync(ANDROID_MANIFEST)) {
    console.log("[patch-native-permissions] Skipping Android — AndroidManifest.xml not found (run `npx cap add android` first).");
    return;
  }
  let manifest = readFileSync(ANDROID_MANIFEST, "utf8");
  let changed = false;

  for (const perm of ANDROID_PERMISSIONS) {
    if (manifest.includes(`android:name="${perm}"`)) continue;
    const entry = `    <uses-permission android:name="${perm}" />\n`;
    const manifestOpenTagEnd = manifest.indexOf(">", manifest.indexOf("<manifest")) + 1;
    manifest = manifest.slice(0, manifestOpenTagEnd) + "\n" + entry + manifest.slice(manifestOpenTagEnd);
    changed = true;
    console.log(`[patch-native-permissions] Android: added ${perm}`);
  }

  // OAuth deep link: <intent-filter> with android:scheme="duospace" on the
  // launcher Activity (the one with the default MAIN/LAUNCHER intent-filter
  // — Capacitor's template has exactly one <activity> block, so we target
  // the first <activity ...>...</activity> that contains android.intent.action.MAIN).
  if (!manifest.includes(`android:scheme="${OAUTH_SCHEME}"`)) {
    const activityMatch = manifest.match(/<activity\b[^>]*>[\s\S]*?android\.intent\.action\.MAIN[\s\S]*?<\/activity>/);
    if (!activityMatch) {
      console.warn(
        "[patch-native-permissions] Could not find the launcher <activity> block in AndroidManifest.xml — add the duospace:// intent-filter manually.",
      );
    } else {
      const block = activityMatch[0];
      const closeTag = "</activity>";
      const insertAt = block.lastIndexOf(closeTag);
      const intentFilter =
        `    <intent-filter>\n` +
        `        <action android:name="android.intent.action.VIEW" />\n` +
        `        <category android:name="android.intent.category.DEFAULT" />\n` +
        `        <category android:name="android.intent.category.BROWSABLE" />\n` +
        `        <data android:scheme="${OAUTH_SCHEME}" android:host="${OAUTH_HOST}" />\n` +
        `    </intent-filter>\n`;
      const patchedBlock = block.slice(0, insertAt) + intentFilter + block.slice(insertAt);
      manifest = manifest.slice(0, activityMatch.index) + patchedBlock + manifest.slice(activityMatch.index + block.length);
      changed = true;
      console.log(`[patch-native-permissions] Android: added intent-filter for ${OAUTH_SCHEME}://${OAUTH_HOST} deep link`);
    }
  }

  if (changed) {
    writeFileSync(ANDROID_MANIFEST, manifest, "utf8");
    console.log("[patch-native-permissions] AndroidManifest.xml updated.");
  } else {
    console.log("[patch-native-permissions] AndroidManifest.xml already has all required permissions and the OAuth deep link.");
  }
}

patchIosPlist();
patchAndroidManifest();
console.log("[patch-native-permissions] Done. Rebuild the native app (Xcode / Android Studio) for changes to take effect.");

#!/usr/bin/env node
/**
 * patch-native-permissions.mjs
 *
 * Root cause this fixes: on a fresh `npx cap add ios` / `npx cap add android`,
 * the generated native projects do NOT include the camera/microphone usage
 * description strings this app needs (`capacitor.config.ts` even leaves a
 * comment saying these "must be set in Xcode" manually). Without them:
 *
 *   - iOS: WKWebView's getUserMedia() is auto-denied by the OS with
 *     `NotAllowedError: Permission denied` — no system prompt ever appears,
 *     because iOS refuses to show a camera/mic permission dialog at all
 *     unless NSCameraUsageDescription / NSMicrophoneUsageDescription exist
 *     in Info.plist. It fails silently and instantly, which is exactly the
 *     symptom reported (no dialog, immediate denial).
 *   - Android: same failure mode if the CAMERA/RECORD_AUDIO permissions are
 *     ever missing from AndroidManifest.xml (normally auto-merged by the
 *     Capacitor camera plugin, but `cap sync` is not guaranteed to have run,
 *     or a manual manifest edit can drop the merge).
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
    // Insert just before the closing </dict></plist> of the top-level dict.
    const closeIdx = plist.lastIndexOf("</dict>");
    if (closeIdx === -1) {
      console.warn(`[patch-native-permissions] Could not find </dict> in Info.plist — skipping ${key}. Add it manually.`);
      continue;
    }
    plist = plist.slice(0, closeIdx) + entry + plist.slice(closeIdx);
    changed = true;
    console.log(`[patch-native-permissions] iOS: added ${key}`);
  }

  if (changed) {
    writeFileSync(IOS_PLIST, plist, "utf8");
    console.log("[patch-native-permissions] iOS Info.plist updated.");
  } else {
    console.log("[patch-native-permissions] iOS Info.plist already has all required usage descriptions.");
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

  if (changed) {
    writeFileSync(ANDROID_MANIFEST, manifest, "utf8");
    console.log("[patch-native-permissions] AndroidManifest.xml updated.");
  } else {
    console.log("[patch-native-permissions] AndroidManifest.xml already has all required permissions.");
  }
}

patchIosPlist();
patchAndroidManifest();
console.log("[patch-native-permissions] Done. Rebuild the native app (Xcode / Android Studio) for changes to take effect.");

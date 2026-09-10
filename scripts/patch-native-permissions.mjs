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
 * 3) FCM push notification plumbing for Android (calls, messages, etc):
 *   - Extra manifest permissions (POST_NOTIFICATIONS, USE_FULL_SCREEN_INTENT,
 *     VIBRATE, WAKE_LOCK, FOREGROUND_SERVICE, FOREGROUND_SERVICE_PHONE_CALL).
 *   - Copies native/android/*.kt (NotificationChannels, CallNotificationService,
 *     CallRingingService) into the app's Kotlin package folder.
 *   - Registers CallNotificationService + CallRingingService in the manifest,
 *     plus a default FCM notification channel meta-data entry.
 *   - Patches MainActivity.kt with the onCreate/onNewIntent/onKeyDown hooks
 *     needed for: creating notification channels at startup, routing
 *     Accept/Decline notification taps back into the web app, and silencing
 *     the incoming-call ringtone on a volume-key press (see
 *     PUSH_NOTIFICATIONS.md for why the power button can't do this).
 *
 * 4) android/settings.gradle actually including the native plugin modules.
 *   `cap sync` regenerates android/capacitor.settings.gradle with a Gradle
 *   module entry per installed plugin, but that file only takes effect if
 *   the top-level settings.gradle has `apply from: 'capacitor.settings.gradle'`
 *   — a line that's easy to lose in a hand-edited settings.gradle without
 *   Gradle ever complaining. Missing it silently drops every native plugin
 *   (Preferences included) from the compiled APK even though
 *   capacitor.plugins.json still lists them, which shows up on-device as
 *   that plugin "failing to register" the first time JS calls it.
 *
 * This script is idempotent — safe to run repeatedly, and safe to run
 * before the native projects exist (it just skips with a clear message).
 * Run it after every `cap add` and every `cap sync`.
 *
 * BUG FIX (confirmed via a real APKForge CI build — see
 * app-plugin-trace.txt's "no VIEW/BROWSABLE intent filter" / "did not
 * survive into the final packaged manifest" findings): this script was
 * previously only reachable through this repo's own `npm run cap:add:android`
 * / `npm run cap:sync` wrapper scripts (package.json). A CI/build tool that
 * calls `npx cap add android` or `npx cap sync` directly — as APKForge's
 * pipeline does — never runs it at all, so a build could report
 * "PREBUILD_VALIDATION_PASSED" while shipping an APK missing
 * android:launchMode="singleTask", the duospace://auth intent-filter, and
 * every native call/location service this file registers. Also wired,
 * below the "scripts" object's `cap:*` entries, as Capacitor CLI's own
 * `capacitor:add:after` / `capacitor:sync:after` / `capacitor:update:after`
 * lifecycle hooks (package.json) — the Capacitor CLI invokes those
 * automatically after its OWN internal add/sync/update commands complete,
 * regardless of which command (ours or a third party's) triggered them, so
 * this can no longer be silently skipped by build tooling that bypasses our
 * npm scripts. The `npm run cap:*` scripts are left as-is too (harmless —
 * this script is idempotent) for local/manual use.
 *
 * Usage:
 *   node scripts/patch-native-permissions.mjs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

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
  // --- Background location (duospace-background-geolocation) ---
  // Both the When-In-Use and Always strings are required even though the
  // app only ever asks for Always: iOS's two-step permission model always
  // shows the When-In-Use prompt first, and refuses to show it at all if
  // NSLocationWhenInUseUsageDescription is missing, even when the app's
  // code calls requestAlwaysAuthorization() directly.
  ["NSLocationWhenInUseUsageDescription", "DuoSpace uses your location to show it to your partner on the map."],
  ["NSLocationAlwaysAndWhenInUseUsageDescription", "DuoSpace shares your live location with your partner, including when the app is in the background."],
  ["NSLocationAlwaysUsageDescription", "DuoSpace shares your live location with your partner, including when the app is in the background."],
];

const ANDROID_PERMISSIONS = [
  "android.permission.CAMERA",
  "android.permission.RECORD_AUDIO",
  // FIX (real reported bug: "microphone permission is granted in Android
  // Settings but the app still says it isn't and voice calls/notes don't
  // work"): RECORD_AUDIO being granted is necessary but not sufficient.
  // Every call goes through Daily.co's WebRTC engine, which — like any
  // Android WebRTC implementation — puts the device into
  // AudioManager.MODE_IN_COMMUNICATION and manages call-audio routing via
  // AudioManager.setMode()/setSpeakerphoneOn() before it will actually open
  // the mic track. Those AudioManager calls require MODIFY_AUDIO_SETTINGS
  // — a separate, "normal" (no runtime prompt needed) permission from
  // RECORD_AUDIO — and this was never declared, so on-device that call
  // throws a SecurityException, WebRTC's audio device module reports
  // "no microphone", and every layer above it (ensureMediaPermission /
  // fromGumError in src/lib/mediaPermissions.ts) has no way to distinguish
  // that from a genuine RECORD_AUDIO denial: it just relays getUserMedia's
  // NotAllowedError, which reads to the person as "permission not
  // granted" even though Settings correctly shows it granted. Being a
  // normal permission, adding it here is the entire fix — no manifest
  // <uses-permission> maxSdk gating and no runtime request flow needed,
  // just the declaration itself.
  "android.permission.MODIFY_AUDIO_SETTINGS",
  "android.permission.INTERNET",
  // --- FCM push / incoming-call notifications ---
  "android.permission.POST_NOTIFICATIONS", // Android 13+ runtime notification permission
  "android.permission.USE_FULL_SCREEN_INTENT", // Android 14+ requires this declared explicitly
  "android.permission.VIBRATE",
  "android.permission.WAKE_LOCK",
  "android.permission.FOREGROUND_SERVICE",
  "android.permission.FOREGROUND_SERVICE_PHONE_CALL", // Android 14+ foreground service type grant
  // --- Telecom / ConnectionService (self-managed — see native/android/TelecomHelper.kt) ---
  // Deliberately NOT requesting CALL_PHONE or READ_PHONE_STATE: those are
  // for apps managing the carrier phone's own calls (system dialer
  // replacements). MANAGE_OWN_CALLS is the correct, much narrower
  // permission for a self-managed ConnectionService, is a "normal"
  // (not runtime-dangerous) permission, and needs no user prompt.
  "android.permission.MANAGE_OWN_CALLS",
  // --- Media / photo library (Android 13+ granular replacements for
  //     READ_EXTERNAL_STORAGE; the legacy ones below are sdk-capped) ---
  "android.permission.READ_MEDIA_IMAGES",
  "android.permission.READ_MEDIA_VIDEO",
  "android.permission.READ_MEDIA_VISUAL_USER_SELECTED", // Android 14 partial photo access
  // --- Background location (duospace-background-geolocation) ---
  "android.permission.ACCESS_FINE_LOCATION",
  "android.permission.ACCESS_COARSE_LOCATION",
  // Android 10+ requires this as a SEPARATE runtime request from the two
  // above — the OS will not even show it in the same permission dialog;
  // it must be requested only after foreground location is already
  // granted (Google Play policy as well as an OS requirement). The plugin
  // itself only requests ACCESS_FINE_LOCATION/ACCESS_COARSE_LOCATION via
  // Capacitor's permission flow; ACCESS_BACKGROUND_LOCATION additionally
  // needs a manual "Allow all the time" selection in system Settings on
  // most OEMs — see docs/BACKGROUND_LOCATION_NATIVE.md.
  "android.permission.ACCESS_BACKGROUND_LOCATION",
  // Android 14+ per-type foreground-service grant, parallel to
  // FOREGROUND_SERVICE_PHONE_CALL above — required for
  // DuoSpaceLocationService's android:foregroundServiceType="location".
  "android.permission.FOREGROUND_SERVICE_LOCATION",
];

/**
 * Legacy storage permissions, only meaningful up to Android 12 — declared
 * with a maxSdkVersion so Play Console doesn't flag them and Android 13+
 * devices use the granular READ_MEDIA_* permissions above instead.
 */
const ANDROID_LEGACY_STORAGE = [
  ["android.permission.READ_EXTERNAL_STORAGE", "32"],
  ["android.permission.WRITE_EXTERNAL_STORAGE", "29"],
];

const APP_PACKAGE = "com.duospace.app";
const ANDROID_JAVA_SRC_DIR = join(ROOT, "android", "app", "src", "main", "java", ...APP_PACKAGE.split("."));
const NATIVE_SOURCE_DIR = join(SCRIPT_DIR, "..", "native", "android");
const NATIVE_GOOGLE_SERVICES_JSON = join(NATIVE_SOURCE_DIR, "google-services.json");
const ANDROID_APP_GOOGLE_SERVICES_JSON = join(ROOT, "android", "app", "google-services.json");
const ANDROID_ROOT_GRADLE = join(ROOT, "android", "build.gradle");
const NATIVE_KOTLIN_FILES = [
  "NotificationChannels.kt", "CallNotificationService.kt", "CallRingingService.kt",
  // Everything CallNotificationService.kt doesn't own (messages,
  // reactions, missed/ended/declined call log, partner requests) — see
  // that file's own header comment for why they must be two services.
  "DuoSpaceMessagingService.kt",
  // Self-managed ConnectionService/TelecomManager integration — see
  // native/android/TelecomHelper.kt for the full design rationale.
  "TelecomHelper.kt", "CallBridge.kt", "DuoSpaceConnection.kt", "DuoSpaceConnectionService.kt",
  // Background/foreground location — see docs/BACKGROUND_LOCATION_NATIVE.md.
  // Started directly by CallNotificationService.kt above (every push, call
  // or message) and by the duospace-background-geolocation plugin's
  // start()/stop()/requestImmediateFix().
  "DuoSpaceLocationService.kt",
];
const MAIN_ACTIVITY_KT = join(ANDROID_JAVA_SRC_DIR, "MainActivity.kt");
const MAIN_ACTIVITY_JAVA = join(ANDROID_JAVA_SRC_DIR, "MainActivity.java");
const ANDROID_SETTINGS_GRADLE = join(ROOT, "android", "settings.gradle");

// Bundled notification/ringtone sound assets — see native/android/res_raw/
// (generated offline, see NOTIFICATION_SOUNDS.md) and NotificationChannels.kt
// / CallRingingService.kt, which reference these by filename (without
// extension) via android.resource://<package>/raw/<name> Uris.
const NATIVE_RES_RAW_DIR = join(SCRIPT_DIR, "..", "native", "android", "res_raw");
const ANDROID_RES_RAW_DIR = join(ROOT, "android", "app", "src", "main", "res", "raw");

const IOS_APP_DIR = join(ROOT, "ios", "App", "App");
const IOS_NATIVE_SOURCE_DIR = join(SCRIPT_DIR, "..", "native", "ios");
const IOS_SWIFT_FILES = ["CallKitManager.swift", "PushKitManager.swift"];
const IOS_SOUNDS_SOURCE_DIR = join(IOS_NATIVE_SOURCE_DIR, "Sounds");
const IOS_SOUNDS_DEST_DIR = join(IOS_APP_DIR, "Sounds");
const APP_DELEGATE_SWIFT = join(IOS_APP_DIR, "AppDelegate.swift");
const IOS_ENTITLEMENTS = join(IOS_APP_DIR, "App.entitlements");

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

  // VoIP calling background modes — required for PushKit/CallKit to wake
  // the app from terminated state on an incoming call. Without `voip`
  // here, PushKit VoIP pushes are still delivered, but the OS will NOT let
  // the app run background code to call reportNewIncomingCall in time, and
  // iOS kills the app for violating the PushKit contract. `audio` keeps
  // the WebRTC audio session alive if the app is backgrounded mid-call.
  // `audio` is also load-bearing for the music player's native audio
  // engine (native-plugins/audio-engine) alongside its original purpose
  // (Daily.co call audio) — no additional mode needed for that feature,
  // it reuses this exact entry. See docs/MUSIC_NATIVE_PLAYBACK.md.
  const requiredBackgroundModes = ["voip", "audio", "remote-notification", "location"];
  const hasBackgroundModesKey = plist.includes("<key>UIBackgroundModes</key>");
  const missingModes = requiredBackgroundModes.filter((m) => !plist.includes(`<string>${m}</string>`));
  if (!hasBackgroundModesKey) {
    const arrayEntry =
      `\t<key>UIBackgroundModes</key>\n\t<array>\n` +
      requiredBackgroundModes.map((m) => `\t\t<string>${m}</string>\n`).join("") +
      `\t</array>\n`;
    const patched = insertBeforeLastCloseDict(plist, arrayEntry);
    if (!patched) {
      console.warn("[patch-native-permissions] Could not find </dict> in Info.plist — add UIBackgroundModes manually.");
    } else {
      plist = patched;
      changed = true;
      console.log(`[patch-native-permissions] iOS: added UIBackgroundModes (${requiredBackgroundModes.join(", ")})`);
    }
  } else if (missingModes.length > 0) {
    // Array key already exists (e.g. from a prior manual edit or another
    // plugin) — insert any missing <string> entries into the existing
    // array rather than creating a second UIBackgroundModes key, which
    // Info.plist does not merge (only the last one present would apply).
    const arrayMatch = plist.match(/<key>UIBackgroundModes<\/key>\s*<array>/);
    if (arrayMatch) {
      const insertAt = arrayMatch.index + arrayMatch[0].length;
      const newEntries = missingModes.map((m) => `\n\t\t<string>${m}</string>`).join("");
      plist = plist.slice(0, insertAt) + newEntries + plist.slice(insertAt);
      changed = true;
      console.log(`[patch-native-permissions] iOS: added missing UIBackgroundModes entries (${missingModes.join(", ")})`);
    } else {
      console.warn("[patch-native-permissions] UIBackgroundModes key found but couldn't locate its <array> — add missing modes manually: " + missingModes.join(", "));
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

  for (const [perm, maxSdk] of ANDROID_LEGACY_STORAGE) {
    if (manifest.includes(`android:name="${perm}"`)) continue;
    const entry = `    <uses-permission android:name="${perm}" android:maxSdkVersion="${maxSdk}" />\n`;
    const manifestOpenTagEnd = manifest.indexOf(">", manifest.indexOf("<manifest")) + 1;
    manifest = manifest.slice(0, manifestOpenTagEnd) + "\n" + entry + manifest.slice(manifestOpenTagEnd);
    changed = true;
    console.log(`[patch-native-permissions] Android: added ${perm} (maxSdkVersion=${maxSdk})`);
  }

  // CRITICAL — Android OAuth deep-link fix (duospace://auth):
  //
  // Root cause of "Google account selected -> app terminates/restarts ->
  // cold splash reappears": Capacitor's default template leaves the
  // launcher Activity at its default launchMode ("standard"). When the
  // system browser redirects back via the duospace://auth VIEW intent
  // (matched by the intent-filter below), Android's default behavior for
  // "standard" launchMode is to instantiate a BRAND NEW Activity on top of
  // the task instead of delivering onNewIntent() to the already-running
  // instance. That new instance cold-boots a fresh WebView (hence the
  // splash reappearing) and is a DIFFERENT Activity/WebView/JS context than
  // the one whose Auth.tsx registered the appUrlOpen listener and holds the
  // PKCE code-verifier state — so the callback is effectively lost, and the
  // system frequently reclaims/finishes the orphaned original Activity
  // under memory pressure, which is what reads as the app "terminating".
  //
  // Fix: android:launchMode="singleTask" on that same Activity. This forces
  // Android to reuse the existing instance and call onNewIntent() on it
  // instead, which is what the App plugin needs to fire `appUrlOpen` in the
  // SAME JS context Auth.tsx is already listening in.
  if (!manifest.includes(`android:launchMode="singleTask"`)) {
    const activityOpenMatch = manifest.match(/<activity\b[^>]*>[\s\S]*?android\.intent\.action\.MAIN[\s\S]*?<\/activity>/);
    // The above also matches on content inside the block; re-locate just the opening tag of that same activity.
    const blockForTag = activityOpenMatch ? activityOpenMatch[0] : null;
    const openTagMatch = blockForTag ? blockForTag.match(/^<activity\b[^>]*>/) : null;
    if (!openTagMatch) {
      console.warn(
        "[patch-native-permissions] Could not find the launcher <activity> opening tag — add android:launchMode=\"singleTask\" to it manually (required for the duospace:// OAuth callback to survive).",
      );
    } else {
      const openTag = openTagMatch[0];
      const patchedOpenTag = openTag.replace(/^<activity\b/, `<activity\n        android:launchMode="singleTask"`);
      manifest = manifest.replace(openTag, patchedOpenTag);
      changed = true;
      console.log('[patch-native-permissions] Android: set android:launchMode="singleTask" on the launcher Activity (fixes OAuth deep-link activity recreation).');
    }
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

  // Second deep-link host on the same scheme: duospace://call?... is how
  // CallNotificationService's Accept/Decline notification actions and
  // MainActivity's onNewIntent hand a call action back to the web app.
  if (manifest.includes(`android:scheme="${OAUTH_SCHEME}"`) && !manifest.includes(`android:host="call"`)) {
    const dataLineMatch = manifest.match(new RegExp(`<data android:scheme="${OAUTH_SCHEME}" android:host="${OAUTH_HOST}" />`));
    if (dataLineMatch) {
      const extraDataLine = `        <data android:scheme="${OAUTH_SCHEME}" android:host="call" />\n`;
      const insertAt = dataLineMatch.index + dataLineMatch[0].length;
      manifest = manifest.slice(0, insertAt) + "\n" + extraDataLine.trimEnd() + manifest.slice(insertAt);
      changed = true;
      console.log(`[patch-native-permissions] Android: added ${OAUTH_SCHEME}://call deep-link host for call notification actions`);
    } else {
      console.warn("[patch-native-permissions] Could not locate the duospace:// data element to extend with host=\"call\" — add it manually.");
    }
  }

  // FCM services: CallNotificationService + CallRingingService, and the
  // default notification channel used when a push's `notification` block
  // doesn't specify android.notification.channel_id explicitly.
  if (!manifest.includes(`.CallNotificationService"`)) {
    const servicesBlock =
      `    <service\n` +
      `        android:name=".CallNotificationService"\n` +
      `        android:exported="false">\n` +
      `        <intent-filter>\n` +
      `            <action android:name="com.google.firebase.MESSAGING_EVENT" />\n` +
      `        </intent-filter>\n` +
      `    </service>\n` +
      `    <service\n` +
      `        android:name=".CallRingingService"\n` +
      `        android:exported="false"\n` +
      `        android:foregroundServiceType="phoneCall" />\n` +
      `    <!-- Self-managed ConnectionService/TelecomManager integration — see\n` +
      `         native/android/TelecomHelper.kt. android:exported must be true:\n` +
      `         the Telecom system service (a different process/UID) is what binds\n` +
      `         to this, not app-internal code, so it needs cross-process bind\n` +
      `         access gated by the platform-signature BIND_TELECOM_CONNECTION_SERVICE\n` +
      `         permission below — that permission is what actually restricts binding\n` +
      `         to the OS, not android:exported="false" (which would block Telecom too). -->\n` +
      `    <service\n` +
      `        android:name=".DuoSpaceConnectionService"\n` +
      `        android:exported="true"\n` +
      `        android:permission="android.permission.BIND_TELECOM_CONNECTION_SERVICE">\n` +
      `        <intent-filter>\n` +
      `            <action android:name="android.telecom.ConnectionService" />\n` +
      `        </intent-filter>\n` +
      `    </service>\n` +
      `    <meta-data\n` +
      `        android:name="com.google.firebase.messaging.default_notification_channel_id"\n` +
      `        android:value="duospace_messages" />\n` +
      `    <!-- Background/foreground location — see docs/BACKGROUND_LOCATION_NATIVE.md\n` +
      `         and native/android/DuoSpaceLocationService.kt. Started directly by\n` +
      `         CallNotificationService.kt above (every push) and by the\n` +
      `         duospace-background-geolocation plugin. android:foregroundServiceType\n` +
      `         requires ACCESS_FINE_LOCATION + ACCESS_BACKGROUND_LOCATION +\n` +
      `         FOREGROUND_SERVICE_LOCATION, already added above. -->\n` +
      `    <service\n` +
      `        android:name=".DuoSpaceLocationService"\n` +
      `        android:exported="false"\n` +
      `        android:foregroundServiceType="location" />\n`;
    const appCloseIdx = manifest.lastIndexOf("</application>");
    if (appCloseIdx === -1) {
      console.warn("[patch-native-permissions] Could not find </application> in AndroidManifest.xml — add the push services manually.");
    } else {
      manifest = manifest.slice(0, appCloseIdx) + servicesBlock + manifest.slice(appCloseIdx);
      changed = true;
      console.log("[patch-native-permissions] Android: registered CallNotificationService + CallRingingService, and the default FCM channel.");
    }
  }

  // DuoSpaceMessagingService: separate guard from the block above so an
  // android/ directory generated before this service existed still gets it
  // added on the next `cap sync` (the block above short-circuits once
  // CallNotificationService is already present, which would otherwise skip
  // this too).
  if (!manifest.includes(`.DuoSpaceMessagingService"`)) {
    const messagingServiceBlock =
      `    <service\n` +
      `        android:name=".DuoSpaceMessagingService"\n` +
      `        android:exported="false">\n` +
      `        <intent-filter>\n` +
      `            <action android:name="com.google.firebase.MESSAGING_EVENT" />\n` +
      `        </intent-filter>\n` +
      `    </service>\n`;
    const appCloseIdx = manifest.lastIndexOf("</application>");
    if (appCloseIdx === -1) {
      console.warn("[patch-native-permissions] Could not find </application> in AndroidManifest.xml — add DuoSpaceMessagingService manually.");
    } else {
      manifest = manifest.slice(0, appCloseIdx) + messagingServiceBlock + manifest.slice(appCloseIdx);
      changed = true;
      console.log("[patch-native-permissions] Android: registered DuoSpaceMessagingService.");
    }
  }

  if (changed) {
    writeFileSync(ANDROID_MANIFEST, manifest, "utf8");
    console.log("[patch-native-permissions] AndroidManifest.xml updated.");
  } else {
    console.log("[patch-native-permissions] AndroidManifest.xml already has all required permissions and the OAuth deep link.");
  }
}

function copyNativeKotlinSources() {
  if (!existsSync(join(ROOT, "android"))) {
    console.log("[patch-native-permissions] Skipping native source copy — android/ not found (run `npx cap add android` first).");
    return;
  }
  mkdirSync(ANDROID_JAVA_SRC_DIR, { recursive: true });
  for (const file of NATIVE_KOTLIN_FILES) {
    const src = join(NATIVE_SOURCE_DIR, file);
    const dest = join(ANDROID_JAVA_SRC_DIR, file);
    if (!existsSync(src)) {
      console.warn(`[patch-native-permissions] Missing template ${src} — skipping.`);
      continue;
    }
    copyFileSync(src, dest);
    console.log(`[patch-native-permissions] Android: copied ${file} into app/src/main/java/${APP_PACKAGE.replaceAll(".", "/")}/`);
  }
}

function copyNotificationSoundAssets() {
  if (!existsSync(join(ROOT, "android"))) {
    console.log("[patch-native-permissions] Skipping notification sound assets — android/ not found (run `npx cap add android` first).");
    return;
  }
  if (!existsSync(NATIVE_RES_RAW_DIR)) {
    console.warn(`[patch-native-permissions] Missing ${NATIVE_RES_RAW_DIR} — notification/call sound picker will fall back to the system default ringtone.`);
    return;
  }
  mkdirSync(ANDROID_RES_RAW_DIR, { recursive: true });
  let count = 0;
  for (const file of readdirSync(NATIVE_RES_RAW_DIR)) {
    if (!file.endsWith(".ogg")) continue;
    copyFileSync(join(NATIVE_RES_RAW_DIR, file), join(ANDROID_RES_RAW_DIR, file));
    count++;
  }
  console.log(`[patch-native-permissions] Android: copied ${count} notification/ringtone sound files into app/src/main/res/raw/.`);
}

// FIX (notification icon renders as a blank/solid white square in the
// status bar and notification tray): every notification builder in
// native/android/*.kt (DuoSpaceMessagingService, CallNotificationService,
// CallRingingService, DuoSpaceLocationService) called
// `.setSmallIcon(applicationInfo.icon)` — the full-color adaptive launcher
// icon. Android 5.0+ never renders a status-bar/notification small icon in
// color: it takes ONLY the icon's alpha channel and fills it flat white,
// silhouette-style (the same treatment every OS-level notification icon
// gets). A launcher icon is a fully-opaque raster with no meaningful alpha
// shape, so that silhouette is just a solid white rounded square/blob —
// exactly the "blank icon" notifications were showing. The fix is a
// dedicated small-icon asset that IS mostly transparent with a simple
// white glyph — generated here (a two-heart glyph matching the app's own
// icon motif) at every mdpi..xxxhdpi density Android expects for a 24dp
// status-bar icon, copied into res/drawable-<density>/ under a stable
// name every native file below now references via R.drawable.ic_stat_duospace
// instead of applicationInfo.icon.
const NATIVE_NOTIFICATION_ICON_DIR = join(SCRIPT_DIR, "..", "native", "android", "res_notification_icon");
const ANDROID_RES_DIR = join(ROOT, "android", "app", "src", "main", "res");

function copyNotificationIconAsset() {
  if (!existsSync(join(ROOT, "android"))) {
    console.log("[patch-native-permissions] Skipping notification icon asset — android/ not found (run `npx cap add android` first).");
    return;
  }
  if (!existsSync(NATIVE_NOTIFICATION_ICON_DIR)) {
    console.warn(`[patch-native-permissions] Missing ${NATIVE_NOTIFICATION_ICON_DIR} — notifications will keep using applicationInfo.icon (may render blank).`);
    return;
  }
  let count = 0;
  for (const densityDir of readdirSync(NATIVE_NOTIFICATION_ICON_DIR)) {
    const srcDir = join(NATIVE_NOTIFICATION_ICON_DIR, densityDir);
    const destDir = join(ANDROID_RES_DIR, densityDir);
    mkdirSync(destDir, { recursive: true });
    for (const file of readdirSync(srcDir)) {
      copyFileSync(join(srcDir, file), join(destDir, file));
      count++;
    }
  }
  console.log(`[patch-native-permissions] Android: copied ${count} notification small-icon assets (ic_stat_duospace) into app/src/main/res/drawable-*/.`);
}

function copyNativeSwiftSources() {
  if (!existsSync(IOS_APP_DIR)) {
    console.log("[patch-native-permissions] Skipping iOS native source copy — ios/App/App not found (run `npx cap add ios` first, on macOS with Xcode).");
    return;
  }
  for (const file of IOS_SWIFT_FILES) {
    const src = join(IOS_NATIVE_SOURCE_DIR, file);
    const dest = join(IOS_APP_DIR, file);
    if (!existsSync(src)) {
      console.warn(`[patch-native-permissions] Missing template ${src} — skipping.`);
      continue;
    }
    copyFileSync(src, dest);
    console.log(`[patch-native-permissions] iOS: copied ${file} into ios/App/App/`);
  }
  copyIosSoundAssets();
  console.warn(
    "[patch-native-permissions] iOS: CallKitManager.swift, PushKitManager.swift, and Sounds/*.caf were copied, " +
    "but Xcode will NOT compile/bundle them until they're added to the App target — open ios/App/App.xcworkspace " +
    "and drag CallKitManager.swift + PushKitManager.swift (\"Add to target: App\", checked) plus the whole Sounds " +
    "folder as a folder reference (blue icon, so filenames stay exact — required for both UNNotificationSound " +
    "and CXProviderConfiguration.ringtoneSound to find them) into the App group. This script cannot modify the " +
    ".pbxproj safely from here.",
  );
}

function copyIosSoundAssets() {
  if (!existsSync(IOS_SOUNDS_SOURCE_DIR)) {
    console.warn(`[patch-native-permissions] Missing ${IOS_SOUNDS_SOURCE_DIR} — iOS call ringtone/message sound picker will fall back to the system default.`);
    return;
  }
  mkdirSync(IOS_SOUNDS_DEST_DIR, { recursive: true });
  let count = 0;
  for (const file of readdirSync(IOS_SOUNDS_SOURCE_DIR)) {
    if (!file.endsWith(".caf")) continue;
    copyFileSync(join(IOS_SOUNDS_SOURCE_DIR, file), join(IOS_SOUNDS_DEST_DIR, file));
    count++;
  }
  console.log(`[patch-native-permissions] iOS: copied ${count} notification/ringtone sound files into ios/App/App/Sounds/.`);
}

/**
 * aps-environment is required for ANY APNs delivery (VoIP or regular) to
 * work outside of Xcode's debugger-attached development sessions — without
 * it, TestFlight/App Store builds silently fail to receive pushes with no
 * error surfaced to the app at all. Capacitor's default template does not
 * include an entitlements file with this key.
 */
function patchIosEntitlements() {
  if (!existsSync(IOS_APP_DIR)) {
    console.log("[patch-native-permissions] Skipping iOS entitlements — ios/App/App not found.");
    return;
  }
  const entitlementsXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0">\n<dict>\n` +
    `\t<key>aps-environment</key>\n\t<string>development</string>\n` +
    `</dict>\n</plist>\n`;

  if (!existsSync(IOS_ENTITLEMENTS)) {
    writeFileSync(IOS_ENTITLEMENTS, entitlementsXml, "utf8");
    console.log("[patch-native-permissions] iOS: created App.entitlements with aps-environment.");
    console.warn(
      "[patch-native-permissions] iOS: App.entitlements was just created — it must be linked in Xcode's " +
      "Signing & Capabilities tab (Push Notifications + Background Modes capabilities) or Xcode will not " +
      "apply it, and set aps-environment to \"production\" before an App Store / TestFlight build.",
    );
  } else {
    const existing = readFileSync(IOS_ENTITLEMENTS, "utf8");
    if (existing.includes("<key>aps-environment</key>")) {
      console.log("[patch-native-permissions] iOS App.entitlements already has aps-environment.");
    } else {
      console.warn(
        `[patch-native-permissions] ${IOS_ENTITLEMENTS} exists but has no aps-environment key — add it manually ` +
        "(this script won't overwrite an existing entitlements file it didn't create).",
      );
    }
  }
}

const APP_DELEGATE_MARKER = "DUOSPACE CALLKIT/PUSHKIT ADDITIONS";

/**
 * Inserted into AppDelegate's `didFinishLaunchingWithOptions`. Starts
 * PushKitManager (registers for VoIP push immediately at launch — Apple
 * requires this, VoIP registration cannot be deferred until after a UI
 * interaction the way regular push permission can), and wires
 * CallKitManager's action callback to forward into the Capacitor WebView
 * as the same `duospace-call-action` event Android dispatches natively —
 * see native/android/CallBridge.kt for the Android equivalent, and
 * native-plugins/callkit-bridge for the alternate plugin-event path this
 * uses instead for JS that specifically listens via the plugin.
 */
const APP_DELEGATE_SWIFT_ADDITIONS = `
        // === ${APP_DELEGATE_MARKER} ===
        PushKitManager.shared.start()
        CallKitManager.shared.onCallAction = { callId, action, isVideo, conversationId, roomName in
            NotificationCenter.default.post(
                name: NSNotification.Name("DuospaceCallAction"),
                object: nil,
                userInfo: [
                    "callId": callId, "action": action, "isVideo": isVideo,
                    "conversationId": conversationId as Any, "roomName": roomName as Any,
                ]
            )
        }
        // === END ${APP_DELEGATE_MARKER} ===
`;

function patchIosAppDelegate() {
  if (!existsSync(APP_DELEGATE_SWIFT)) {
    console.log("[patch-native-permissions] Skipping AppDelegate.swift patch — not found (run `npx cap add ios` first).");
    return;
  }
  let source = readFileSync(APP_DELEGATE_SWIFT, "utf8");
  if (source.includes(APP_DELEGATE_MARKER)) {
    console.log("[patch-native-permissions] AppDelegate.swift already has the CallKit/PushKit additions.");
    return;
  }
  // Capacitor's default template: `func application(_ application: UIApplication,
  // didFinishLaunchingWithOptions ...) -> Bool {` followed by a `return true`.
  // Insert right after the opening brace of that specific method, not just
  // any `{` — this regex requires "didFinishLaunchingWithOptions" on the
  // same declaration to avoid matching some other method.
  const methodMatch = source.match(/func application\([^)]*didFinishLaunchingWithOptions[^{]*\{/);
  if (!methodMatch) {
    console.warn(
      "[patch-native-permissions] Could not find didFinishLaunchingWithOptions in AppDelegate.swift — " +
      "add the snippet from native/ios/AppDelegate-additions.swift.snippet manually.",
    );
    return;
  }
  const insertAt = methodMatch.index + methodMatch[0].length;
  source = source.slice(0, insertAt) + APP_DELEGATE_SWIFT_ADDITIONS + source.slice(insertAt);
  writeFileSync(APP_DELEGATE_SWIFT, source, "utf8");
  console.log("[patch-native-permissions] AppDelegate.swift: added PushKit/CallKit startup hooks.");
}

const MAIN_ACTIVITY_MARKER = "DUOSPACE PUSH ADDITIONS";

const MAIN_ACTIVITY_KOTLIN_ADDITIONS = `
    // === ${MAIN_ACTIVITY_MARKER} (added by scripts/patch-native-permissions.mjs) ===

    companion object {
        // Generated once when this class is first loaded into a process (a
        // Kotlin \`companion object\` property initializer runs exactly once
        // per classloader, i.e. once per process — not once per Activity
        // instance). Two logcat lines with a DIFFERENT token mean the OS
        // killed the whole process in between and this is a fresh cold
        // start; the SAME token across onPause (backgrounding for the OAuth
        // browser) and onNewIntent/onCreate (the callback returning) is the
        // definitive proof that the process survived the round-trip. This is
        // a stronger signal than savedInstanceState alone, which is also
        // null on a plain first launch and can't by itself distinguish
        // "fresh process" from "same process, first Activity creation".
        private val PROCESS_TOKEN = "p_" + System.currentTimeMillis().toString(36) + "_" + (1000..9999).random()
    }

    private fun lifecycleLog(event: String) {
        android.util.Log.i(
            "DuoSpaceLifecycle",
            "$event processToken=$PROCESS_TOKEN instance=\${System.identityHashCode(this)} isFinishing=$isFinishing isChangingConfigurations=$isChangingConfigurations",
        )
    }

    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        // Logged BEFORE super.onCreate() so the "was this process already
        // alive" question is answered from the very first line of Activity
        // startup, before Capacitor's own bridge/plugin init runs.
        android.util.Log.i(
            "DuoSpaceLifecycle",
            "onCreate processToken=$PROCESS_TOKEN instance=\${System.identityHashCode(this)} " +
                "savedInstanceState=\${if (savedInstanceState != null) "present (config-change restore, same process)" else "null (first creation in this process)"} " +
                "intentAction=\${intent?.action} intentData=\${intent?.data}",
        )
        super.onCreate(savedInstanceState)
        com.duospace.app.NotificationChannels.createAll(this)
        // Idempotent — safe to call on every app start. See TelecomHelper.kt.
        com.duospace.app.TelecomHelper.registerPhoneAccount(this)
        logIfOAuthCallback(intent, "onCreate")
        handleDuospaceCallIntent(intent)
        handleDuospaceNotificationIntent(intent)
    }

    override fun onStart() {
        super.onStart()
        lifecycleLog("onStart")
    }

    override fun onResume() {
        super.onResume()
        lifecycleLog("onResume")
    }

    override fun onPause() {
        // Fires right before the system browser takes the foreground for
        // Google Sign-In — the PROCESS_TOKEN logged here is the baseline to
        // compare against whatever's logged when the duospace://auth
        // callback comes back.
        lifecycleLog("onPause (backgrounding — e.g. system browser opening for OAuth)")
        super.onPause()
    }

    override fun onStop() {
        lifecycleLog("onStop")
        super.onStop()
    }

    override fun onDestroy() {
        // If this fires during the OAuth round-trip with isFinishing=false
        // and isChangingConfigurations=false, the OS reclaimed this Activity
        // under memory pressure while the browser was in the foreground —
        // the actual native-level cause of "app terminates/restarts after
        // Google Sign-In", as distinct from a launchMode/intent-filter
        // misconfiguration (which would show up as onCreate instead of
        // onNewIntent in logIfOAuthCallback below, not as an onDestroy here).
        android.util.Log.w(
            "DuoSpaceLifecycle",
            "onDestroy processToken=$PROCESS_TOKEN instance=\${System.identityHashCode(this)} " +
                "isFinishing=$isFinishing isChangingConfigurations=$isChangingConfigurations" +
                if (!isFinishing && !isChangingConfigurations)
                    " — UNEXPECTED: Activity destroyed by the system, not by user/config-change. If this happened mid-OAuth, the process was reclaimed for memory."
                else "",
        )
        super.onDestroy()
    }

    override fun onNewIntent(intent: android.content.Intent?) {
        android.util.Log.i(
            "DuoSpaceLifecycle",
            "onNewIntent RECEIVED processToken=$PROCESS_TOKEN instance=\${System.identityHashCode(this)} " +
                "action=\${intent?.action} data=\${intent?.data} flags=\${intent?.flags?.let { java.lang.Integer.toHexString(it) }}",
        )
        super.onNewIntent(intent)
        // super.onNewIntent() is BridgeActivity's own implementation, which
        // calls Bridge.onNewIntent(intent) internally — THAT is what fires
        // the JS 'appUrlOpen' event Auth.tsx is listening for. By the time
        // this next line runs, that JS event has already been dispatched
        // (or, if nothing logs next in [DuoSpaceOAuth][auth.deeplink], the
        // JS-side listener from Auth.tsx's useEffect was never registered —
        // check whether Auth.tsx was even mounted at the time this fired).
        android.util.Log.i(
            "DuoSpaceOAuth",
            "onNewIntent -> super.onNewIntent() returned; Capacitor Bridge.onNewIntent() has run. " +
                "If this intent carries duospace://auth data, JS 'appUrlOpen' has now fired — " +
                "next expected line is [DuoSpaceOAuth][auth.deeplink] from Auth.tsx.",
        )
        logIfOAuthCallback(intent, "onNewIntent")
        handleDuospaceCallIntent(intent)
        handleDuospaceNotificationIntent(intent)
    }

    /**
     * Diagnostic only — does not affect routing. Capacitor's own Bridge
     * (invoked via super.onNewIntent above) is what actually fires the JS
     * \`appUrlOpen\` event; this just proves, from native logcat, WHICH
     * lifecycle method delivered the duospace://auth callback.
     *
     * Expected/healthy: "onNewIntent" (activity reused, launchMode=singleTask
     * doing its job — see AndroidManifest.xml).
     * Red flag: "onCreate" — the Activity was recreated instead of reused,
     * which reproduces the "app terminates/restarts after Google sign-in"
     * bug. If you see this, verify android:launchMode="singleTask" is
     * actually present on this Activity in the built APK's manifest (run
     * \`npm run cap:sync\` so scripts/patch-native-permissions.mjs re-applies
     * it, then a full \`./gradlew clean\`).
     */
    private fun logIfOAuthCallback(intent: android.content.Intent?, via: String) {
        val data = intent?.data ?: return
        if (data.scheme == "duospace" && data.host == "auth") {
            val level = if (via == "onNewIntent") android.util.Log.INFO else android.util.Log.WARN
            val pathPart = data.path.orEmpty()
            val hasCode = data.getQueryParameter("code") != null
            val hasError = data.getQueryParameter("error") != null || data.getQueryParameter("error_description") != null
            var msg = "duospace://auth callback delivered via $via (path=$pathPart, hasCode=$hasCode, hasError=$hasError, processToken=$PROCESS_TOKEN)"
            if (via == "onCreate") {
                msg += " — ACTIVITY WAS RECREATED, expected onNewIntent; check launchMode=singleTask"
            }
            android.util.Log.println(level, "DuoSpaceOAuth", msg)
        }
    }

    private fun handleDuospaceCallIntent(intent: android.content.Intent?) {
        val callId = intent?.getStringExtra("callId") ?: return
        val action = intent.getStringExtra("callAction")

        // Whether accepted, declined, or just tapped to open the app, the
        // ringtone/vibration loop should stop — the in-app IncomingCallOverlay
        // (JS) takes over from here for "accept".
        val stopIntent = android.content.Intent(this, com.duospace.app.CallRingingService::class.java).apply {
            this.action = com.duospace.app.CallRingingService.ACTION_STOP
        }
        startService(stopIntent)

        val payload = org.json.JSONObject().apply {
            put("callId", callId)
            put("action", action ?: "open")
            put("callType", intent.getStringExtra("callType"))
            put("conversationId", intent.getStringExtra("conversationId"))
            put("roomName", intent.getStringExtra("roomName"))
        }
        bridge?.webView?.post {
            bridge?.webView?.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('duospace-call-action', { detail: \${payload} }))",
                null,
            )
        }
    }

    /**
     * Sibling of handleDuospaceCallIntent above, for taps on the
     * non-ringing notifications DuoSpaceMessagingService.kt builds (chat
     * messages, reactions, missed/ended/declined call log entries, partner
     * requests, etc — see native/android/DuoSpaceMessagingService.kt).
     * Guarded on "pushType" (set by that service's PendingIntent extras) so
     * it never fires for an ordinary launcher-icon tap, and is a no-op for
     * "callId" intents (handleDuospaceCallIntent above already owns those —
     * mutually exclusive by which extra is present).
     */
    private fun handleDuospaceNotificationIntent(intent: android.content.Intent?) {
        if (intent?.getStringExtra("callId") != null) return
        val pushType = intent?.getStringExtra("pushType") ?: return
        val payload = org.json.JSONObject().apply {
            put("type", pushType)
            put("conversationId", intent.getStringExtra("conversationId"))
        }
        bridge?.webView?.post {
            bridge?.webView?.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('duospace-notification-tap', { detail: \${payload} }))",
                null,
            )
        }
    }

    /**
     * Silences the incoming-call ringtone/vibration on a physical volume-key
     * press, without touching system volume and without ending the call —
     * matching real phone behavior.
     *
     * PLATFORM NOTE: the power button intentionally is NOT wired here. On
     * stock Android, silencing a ringing call with the power button is
     * handled by the system's own Telecom/Phone stack (the default dialer),
     * which third-party apps cannot hook into — KEYCODE_POWER is not
     * delivered to app activities at all. Only the volume keys are
     * interceptable by a normal foreground Activity, so that's what's
     * implemented here.
     */
    override fun onKeyDown(keyCode: Int, event: android.view.KeyEvent?): Boolean {
        if ((keyCode == android.view.KeyEvent.KEYCODE_VOLUME_UP || keyCode == android.view.KeyEvent.KEYCODE_VOLUME_DOWN) &&
            com.duospace.app.CallRingingService.isRinging && !com.duospace.app.CallRingingService.isSilenced
        ) {
            val silenceIntent = android.content.Intent(this, com.duospace.app.CallRingingService::class.java).apply {
                this.action = com.duospace.app.CallRingingService.ACTION_SILENCE
            }
            startService(silenceIntent)
            return true
        }
        return super.onKeyDown(keyCode, event)
    }
    // === END ${MAIN_ACTIVITY_MARKER} ===
`;

// Java port of MAIN_ACTIVITY_KOTLIN_ADDITIONS above — same behavior, same
// log tags/messages, for the Capacitor Java MainActivity template. Keep the
// two in sync by hand if either changes; see that constant's inline
// comments for the reasoning behind each hook (not repeated here).
const MAIN_ACTIVITY_JAVA_ADDITIONS = `
    // === ${MAIN_ACTIVITY_MARKER} (added by scripts/patch-native-permissions.mjs) ===

    private static final String PROCESS_TOKEN =
        "p_" + Long.toString(System.currentTimeMillis(), 36) + "_" + (1000 + (int) (Math.random() * 9000));

    private void lifecycleLog(String event) {
        android.util.Log.i(
            "DuoSpaceLifecycle",
            event + " processToken=" + PROCESS_TOKEN + " instance=" + System.identityHashCode(this) +
                " isFinishing=" + isFinishing() + " isChangingConfigurations=" + isChangingConfigurations()
        );
    }

    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        android.content.Intent __initialIntent = getIntent();
        android.util.Log.i(
            "DuoSpaceLifecycle",
            "onCreate processToken=" + PROCESS_TOKEN + " instance=" + System.identityHashCode(this) +
                " savedInstanceState=" + (savedInstanceState != null
                    ? "present (config-change restore, same process)"
                    : "null (first creation in this process)") +
                " intentAction=" + (__initialIntent != null ? __initialIntent.getAction() : null) +
                " intentData=" + (__initialIntent != null ? __initialIntent.getData() : null)
        );
        super.onCreate(savedInstanceState);
        com.duospace.app.NotificationChannels.createAll(this); // @JvmStatic — real static method
        com.duospace.app.TelecomHelper.INSTANCE.registerPhoneAccount(this); // plain Kotlin object — no @JvmStatic, needs .INSTANCE from Java
        logIfOAuthCallback(__initialIntent, "onCreate");
        handleDuospaceCallIntent(__initialIntent);
        handleDuospaceNotificationIntent(__initialIntent);
    }

    @Override
    public void onStart() {
        super.onStart();
        lifecycleLog("onStart");
    }

    @Override
    public void onResume() {
        super.onResume();
        lifecycleLog("onResume");
    }

    @Override
    public void onPause() {
        lifecycleLog("onPause (backgrounding — e.g. system browser opening for OAuth)");
        super.onPause();
    }

    @Override
    public void onStop() {
        lifecycleLog("onStop");
        super.onStop();
    }

    @Override
    public void onDestroy() {
        boolean __unexpected = !isFinishing() && !isChangingConfigurations();
        android.util.Log.w(
            "DuoSpaceLifecycle",
            "onDestroy processToken=" + PROCESS_TOKEN + " instance=" + System.identityHashCode(this) +
                " isFinishing=" + isFinishing() + " isChangingConfigurations=" + isChangingConfigurations() +
                (__unexpected
                    ? " — UNEXPECTED: Activity destroyed by the system, not by user/config-change. If this happened mid-OAuth, the process was reclaimed for memory."
                    : "")
        );
        super.onDestroy();
    }

    @Override
    public void onNewIntent(android.content.Intent intent) {
        android.util.Log.i(
            "DuoSpaceLifecycle",
            "onNewIntent RECEIVED processToken=" + PROCESS_TOKEN + " instance=" + System.identityHashCode(this) +
                " action=" + (intent != null ? intent.getAction() : null) +
                " data=" + (intent != null ? intent.getData() : null) +
                " flags=" + (intent != null ? Integer.toHexString(intent.getFlags()) : null)
        );
        super.onNewIntent(intent);
        android.util.Log.i(
            "DuoSpaceOAuth",
            "onNewIntent -> super.onNewIntent() returned; Capacitor Bridge.onNewIntent() has run. " +
                "If this intent carries duospace://auth data, JS 'appUrlOpen' has now fired — " +
                "next expected line is [DuoSpaceOAuth][auth.deeplink] from Auth.tsx."
        );
        logIfOAuthCallback(intent, "onNewIntent");
        handleDuospaceCallIntent(intent);
        handleDuospaceNotificationIntent(intent);
    }

    /** See the Kotlin version of this method (MAIN_ACTIVITY_KOTLIN_ADDITIONS
     *  in patch-native-permissions.mjs) for the full doc comment — identical
     *  behavior here. */
    private void logIfOAuthCallback(android.content.Intent intent, String via) {
        android.net.Uri data = intent != null ? intent.getData() : null;
        if (data == null) return;
        if ("duospace".equals(data.getScheme()) && "auth".equals(data.getHost())) {
            int level = "onNewIntent".equals(via) ? android.util.Log.INFO : android.util.Log.WARN;
            String pathPart = data.getPath() != null ? data.getPath() : "";
            boolean hasCode = data.getQueryParameter("code") != null;
            boolean hasError = data.getQueryParameter("error") != null || data.getQueryParameter("error_description") != null;
            String msg = "duospace://auth callback delivered via " + via + " (path=" + pathPart +
                ", hasCode=" + hasCode + ", hasError=" + hasError + ", processToken=" + PROCESS_TOKEN + ")";
            if ("onCreate".equals(via)) {
                msg += " — ACTIVITY WAS RECREATED, expected onNewIntent; check launchMode=singleTask";
            }
            android.util.Log.println(level, "DuoSpaceOAuth", msg);
        }
    }

    private void handleDuospaceCallIntent(android.content.Intent intent) {
        if (intent == null) return;
        String callId = intent.getStringExtra("callId");
        if (callId == null) return;
        String action = intent.getStringExtra("callAction");

        android.content.Intent stopIntent = new android.content.Intent(this, com.duospace.app.CallRingingService.class);
        stopIntent.setAction(com.duospace.app.CallRingingService.ACTION_STOP);
        startService(stopIntent);

        try {
            org.json.JSONObject payload = new org.json.JSONObject();
            payload.put("callId", callId);
            payload.put("action", action != null ? action : "open");
            payload.put("callType", intent.getStringExtra("callType"));
            payload.put("conversationId", intent.getStringExtra("conversationId"));
            payload.put("roomName", intent.getStringExtra("roomName"));
            final String __js = "window.dispatchEvent(new CustomEvent('duospace-call-action', { detail: " + payload.toString() + " }))";
            if (getBridge() != null && getBridge().getWebView() != null) {
                getBridge().getWebView().post(new Runnable() {
                    @Override
                    public void run() {
                        if (getBridge() != null && getBridge().getWebView() != null) {
                            getBridge().getWebView().evaluateJavascript(__js, null);
                        }
                    }
                });
            }
        } catch (org.json.JSONException e) {
            android.util.Log.w("DuoSpaceLifecycle", "handleDuospaceCallIntent: payload build failed", e);
        }
    }

    /** See the Kotlin version's handleDuospaceNotificationIntent doc comment
     *  (MAIN_ACTIVITY_KOTLIN_ADDITIONS) — identical behavior here. */
    private void handleDuospaceNotificationIntent(android.content.Intent intent) {
        if (intent == null) return;
        if (intent.getStringExtra("callId") != null) return;
        String pushType = intent.getStringExtra("pushType");
        if (pushType == null) return;
        try {
            org.json.JSONObject payload = new org.json.JSONObject();
            payload.put("type", pushType);
            payload.put("conversationId", intent.getStringExtra("conversationId"));
            final String __js = "window.dispatchEvent(new CustomEvent('duospace-notification-tap', { detail: " + payload.toString() + " }))";
            if (getBridge() != null && getBridge().getWebView() != null) {
                getBridge().getWebView().post(new Runnable() {
                    @Override
                    public void run() {
                        if (getBridge() != null && getBridge().getWebView() != null) {
                            getBridge().getWebView().evaluateJavascript(__js, null);
                        }
                    }
                });
            }
        } catch (org.json.JSONException e) {
            android.util.Log.w("DuoSpaceLifecycle", "handleDuospaceNotificationIntent: payload build failed", e);
        }
    }

    /** See the Kotlin version's doc comment (MAIN_ACTIVITY_KOTLIN_ADDITIONS) —
     *  identical platform reasoning for why only volume keys are wired here. */
    @Override
    public boolean onKeyDown(int keyCode, android.view.KeyEvent event) {
        // NOTE: isRinging/isSilenced are Kotlin \`var ... private set\` companion
        // properties (see native/android/CallRingingService.kt) — not
        // @JvmStatic/@JvmField, so from Java they're only reachable through
        // the Kotlin-generated Companion getters, not as plain static fields
        // (unlike ACTION_STOP/ACTION_SILENCE above, which are \`const val\`
        // and do compile to real static fields either language can use
        // directly).
        if ((keyCode == android.view.KeyEvent.KEYCODE_VOLUME_UP || keyCode == android.view.KeyEvent.KEYCODE_VOLUME_DOWN) &&
            com.duospace.app.CallRingingService.Companion.isRinging() && !com.duospace.app.CallRingingService.Companion.isSilenced()
        ) {
            android.content.Intent silenceIntent = new android.content.Intent(this, com.duospace.app.CallRingingService.class);
            silenceIntent.setAction(com.duospace.app.CallRingingService.ACTION_SILENCE);
            startService(silenceIntent);
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }
    // === END ${MAIN_ACTIVITY_MARKER} ===
`;

/**
 * FIX: the Preferences plugin (and in principle any plugin) was reported
 * "unable to register" on Android. capacitor.plugins.json — the JS-bridge
 * manifest that tells the WebView which plugin classes to look for — is a
 * completely separate mechanism from whether those classes actually get
 * *compiled into the APK*. That second part is wired by
 * android/capacitor.settings.gradle (regenerated by every `cap sync`) being
 * pulled into the build via a `apply from: 'capacitor.settings.gradle'`
 * line in the top-level android/settings.gradle. `cap add`/`cap sync`
 * always writes that line — but it's plain Groovy in a file developers
 * routinely hand-edit for other reasons (adding a module, changing
 * `rootProject.name`, etc.), and it's easy to lose without Gradle
 * complaining: a missing include there doesn't fail the build, it just
 * silently drops every native plugin module from compilation. The result
 * on-device is Capacitor's bridge logging "Unable to register plugin
 * instance" the first time JS calls that plugin — for whichever plugin's
 * code path happens to be hit first, which is very often Preferences since
 * it's usually one of the earliest calls the app makes (auth/session
 * storage on boot).
 *
 * This repairs it the same way the rest of this script repairs manifest/
 * plist gaps: idempotently re-adds the line if it's missing, changes
 * nothing if it's already there.
 */
function patchAndroidSettingsGradle() {
  if (!existsSync(ANDROID_SETTINGS_GRADLE)) {
    console.log("[patch-native-permissions] Skipping settings.gradle patch — android/settings.gradle not found (run `npx cap add android` first).");
    return;
  }
  const source = readFileSync(ANDROID_SETTINGS_GRADLE, "utf8");
  if (/apply from:\s*['"]capacitor\.settings\.gradle['"]/.test(source)) {
    console.log("[patch-native-permissions] android/settings.gradle already applies capacitor.settings.gradle.");
    return;
  }
  const appended = source.replace(/\s*$/, "") + "\n\napply from: 'capacitor.settings.gradle'\n";
  writeFileSync(ANDROID_SETTINGS_GRADLE, appended, "utf8");
  console.log(
    "[patch-native-permissions] android/settings.gradle: added missing `apply from: 'capacitor.settings.gradle'` " +
    "— without this line every native plugin module (Preferences included) silently drops out of the build.",
  );
}

function patchMainActivity() {
  // BUG FIX (confirmed via a real APKForge build log — app-plugin-trace.txt /
  // browser-plugin-trace.txt): `cap add android` on this project's pinned
  // Capacitor version (8.5.0) generates MainActivity.**java**, not .kt — this
  // function used to just warn-and-return for the Java case, silently
  // shipping every APK without the onNewIntent/onCreate/onKeyDown hooks
  // below (notification-channel creation, Telecom phone-account
  // registration, call-notification-tap routing, ringtone volume-key
  // silence, and the diagnostic logging that tells onCreate vs onNewIntent
  // apart for the OAuth-recreation bug this same script's manifest patch
  // fixes). A "PREBUILD_VALIDATION_PASSED" build could ship with none of
  // this applied and nothing failing loudly enough to notice. Now patches
  // whichever template actually exists.
  if (existsSync(MAIN_ACTIVITY_JAVA)) {
    patchMainActivityJava();
    return;
  }
  if (!existsSync(MAIN_ACTIVITY_KT)) {
    console.log("[patch-native-permissions] Skipping MainActivity patch — neither MainActivity.kt nor MainActivity.java found (run `npx cap add android` first).");
    return;
  }
  let source = readFileSync(MAIN_ACTIVITY_KT, "utf8");
  if (source.includes(MAIN_ACTIVITY_MARKER)) {
    console.log("[patch-native-permissions] MainActivity.kt already has the push-notification additions.");
    return;
  }

  const classOpenMatch = source.match(/class MainActivity\s*:\s*BridgeActivity\s*\(\s*\)\s*\{/);
  if (!classOpenMatch) {
    console.warn(
      "[patch-native-permissions] Could not find `class MainActivity : BridgeActivity() {` in MainActivity.kt — " +
      "add the snippet from native/android/MainActivity-additions.kt.snippet manually.",
    );
    return;
  }
  const insertAt = classOpenMatch.index + classOpenMatch[0].length;
  source = source.slice(0, insertAt) + MAIN_ACTIVITY_KOTLIN_ADDITIONS + source.slice(insertAt);
  writeFileSync(MAIN_ACTIVITY_KT, source, "utf8");
  console.log("[patch-native-permissions] MainActivity.kt: added onCreate/onNewIntent/onKeyDown push-notification hooks.");
}

function patchMainActivityJava() {
  let source = readFileSync(MAIN_ACTIVITY_JAVA, "utf8");
  if (source.includes(MAIN_ACTIVITY_MARKER)) {
    console.log("[patch-native-permissions] MainActivity.java already has the push-notification additions.");
    return;
  }
  // Capacitor's stock Java template: `public class MainActivity extends BridgeActivity {}`
  // (see browser-plugin-trace.txt for the exact generated contents this
  // matches on this Capacitor version) — an empty body, no existing
  // overrides to collide with.
  const classOpenMatch = source.match(/public\s+class\s+MainActivity\s+extends\s+BridgeActivity\s*\{/);
  if (!classOpenMatch) {
    console.warn(
      "[patch-native-permissions] Could not find `public class MainActivity extends BridgeActivity {` in MainActivity.java — " +
      "add the equivalent of native/android/MainActivity-additions.kt.snippet by hand (Java).",
    );
    return;
  }
  const insertAt = classOpenMatch.index + classOpenMatch[0].length;
  source = source.slice(0, insertAt) + MAIN_ACTIVITY_JAVA_ADDITIONS + source.slice(insertAt);
  // Capacitor's Java template has no imports beyond BridgeActivity; the
  // additions below use only fully-qualified names (same approach the
  // Kotlin additions take) so no extra `import` lines are needed.
  writeFileSync(MAIN_ACTIVITY_JAVA, source, "utf8");
  console.log("[patch-native-permissions] MainActivity.java: added onCreate/onNewIntent/onKeyDown push-notification hooks.");
}

/**
 * Bundle identifier enforcement.
 *
 * Capacitor's `appId` in capacitor.config.json is only applied when the
 * native project is first generated (`npx cap add ios|android`). If a
 * native project was generated before the id was settled — or by a
 * different tool — the Xcode `PRODUCT_BUNDLE_IDENTIFIER` and the Gradle
 * `applicationId` silently keep whatever they were created with, which
 * breaks push (APNs/FCM app id), OAuth callbacks and store uploads. This
 * step pins both to APP_PACKAGE on every `cap sync`.
 */
const IOS_PBXPROJ = join(ROOT, "ios", "App", "App.xcodeproj", "project.pbxproj");
const ANDROID_APP_GRADLE = join(ROOT, "android", "app", "build.gradle");

/**
 * FIX (confirmed via a real APKForge CI build — 8 "cannot find symbol" /
 * "package ... does not exist" errors in :app:compileReleaseJavaWithJavac,
 * all pointing at NotificationChannels/TelecomHelper/CallRingingService):
 *
 * copyNativeKotlinSources() above drops seven .kt files straight into
 * app/src/main/java/com/duospace/app/ — but a stock `cap add android`
 * project on this Capacitor version generates a **Java-only** app module
 * (`apply plugin: 'com.android.application'` with no Kotlin plugin at
 * all — see patchMainActivity()'s own note that MainActivity comes out
 * as .java, not .kt). Without `apply plugin: 'kotlin-android'` on the
 * app module specifically, Gradle never runs a `:app:compileReleaseKotlin`
 * task, so those seven files are silently never compiled — they just sit
 * on disk. MainActivity.java (patched by patchMainActivityJava() above)
 * references their classes directly (`com.duospace.app.NotificationChannels`,
 * `com.duospace.app.TelecomHelper`, `com.duospace.app.CallRingingService`),
 * so javac fails with "cannot find symbol" / "package does not exist" on
 * every one of those references.
 *
 * This is specific to the **app** module. Every native plugin module
 * (native-plugins/*\/android/build.gradle) already applies
 * `apply plugin: 'kotlin-android'` itself — those compile fine, which is
 * why NATIVE_MODULE_COMPILE and the earlier plugin-module Gradle tasks in
 * the log all pass; only :app fails. The Kotlin Gradle Plugin classpath
 * itself is already handled at the root project level by
 * patch-native-kotlin-versions.mjs (which pins kotlin-gradle-plugin
 * 2.1.0 into android/build.gradle / the CLI's android-template), so this
 * only needs to apply the plugin to the app module — applying
 * kotlin-android pulls in a matching kotlin-stdlib automatically (Kotlin
 * Gradle Plugin default since 1.4), so no explicit stdlib dependency is
 * added here. (An earlier draft of this fix also injected an explicit
 * `"org.jetbrains.kotlin:kotlin-stdlib:$kotlin_version"` dependency line,
 * but `kotlin_version` there would have resolved against whatever ext
 * property happens to be in scope for the app module specifically — not
 * guaranteed to be defined, since the root-level patch in
 * patch-native-kotlin-versions.mjs sets it inside its own `buildscript{}`
 * closure, a different property scope. Getting that wrong would throw a
 * Groovy MissingPropertyException and break the build harder than the
 * original bug. Left out rather than risk it.)
 */
function patchAppGradleForKotlin() {
  if (!existsSync(ANDROID_APP_GRADLE)) {
    console.log("[patch-native-permissions] Skipping Kotlin app-module patch — android/app/build.gradle not found (run `npx cap add android` first).");
    return;
  }
  let source = readFileSync(ANDROID_APP_GRADLE, "utf8");
  let changed = false;

  if (!/apply\s+plugin:\s*['"]kotlin-android['"]/.test(source)) {
    const appPluginMatch = source.match(/apply\s+plugin:\s*['"]com\.android\.application['"]\s*\n?/);
    if (!appPluginMatch) {
      console.warn(
        "[patch-native-permissions] Could not find `apply plugin: 'com.android.application'` in android/app/build.gradle — " +
        "add `apply plugin: 'kotlin-android'` to it manually, or the copied native/android/*.kt sources " +
        "(NotificationChannels, TelecomHelper, CallRingingService, etc.) will silently fail to compile.",
      );
    } else {
      const insertAt = appPluginMatch.index + appPluginMatch[0].length;
      source = source.slice(0, insertAt) + "apply plugin: 'kotlin-android'\n" + source.slice(insertAt);
      changed = true;
      console.log("[patch-native-permissions] Android: applied kotlin-android plugin to app/build.gradle (required to compile the copied native/android/*.kt sources).");
    }
  }

  if (changed) {
    writeFileSync(ANDROID_APP_GRADLE, source, "utf8");
  } else {
    console.log("[patch-native-permissions] android/app/build.gradle already has the kotlin-android plugin.");
  }
}

/**
 * FIX (confirmed via a real APKForge CI build, the run right after the
 * kotlin-android patch above landed — :app:compileReleaseKotlin FAILED
 * with ~25 "Unresolved reference" errors: FusedLocationProviderClient,
 * LocationCallback, LocationRequest, LocationServices, Priority,
 * CancellationTokenSource, LocationResult, all in DuoSpaceLocationService.kt):
 *
 * DuoSpaceLocationService.kt (copied into app/src/main/java/com/duospace/app/
 * by copyNativeKotlinSources(), same as the files above) imports Google
 * Play Services' com.google.android.gms.location.* APIs directly. That
 * library IS already a dependency in this project — but only inside
 * native-plugins/background-geolocation/android/build.gradle, declared
 * as `implementation "com.google.android.gms:play-services-location:21.3.0"`.
 * `implementation` scope is deliberately non-transitive: it's on that
 * plugin module's own compile classpath only, not exposed to any module
 * that merely depends on the plugin (which is how :app depends on it,
 * via the Capacitor plugin wiring) — so the app module's *own* Kotlin
 * source has no visibility into it at all, hence "Unresolved reference"
 * rather than a version conflict. Same root shape as the kotlin-android
 * gap above: a native/android/*.kt file needs something the app module
 * doesn't have on its own classpath.
 *
 * Fix: declare the same dependency directly on the app module, pinned to
 * the same version already used by background-geolocation so both
 * modules resolve to a single consistent copy on the merged classpath.
 */
function patchAppGradleForLocationServices() {
  if (!existsSync(ANDROID_APP_GRADLE)) {
    console.log("[patch-native-permissions] Skipping Play Services Location app-module patch — android/app/build.gradle not found (run `npx cap add android` first).");
    return;
  }
  let source = readFileSync(ANDROID_APP_GRADLE, "utf8");

  if (/com\.google\.android\.gms:play-services-location/.test(source)) {
    console.log("[patch-native-permissions] android/app/build.gradle already depends on play-services-location.");
    return;
  }

  const depsMatch = source.match(/dependencies\s*\{[ \t]*\n/);
  if (!depsMatch) {
    console.warn(
      "[patch-native-permissions] Could not find a `dependencies {` block in android/app/build.gradle — " +
      "add `implementation \"com.google.android.gms:play-services-location:21.3.0\"` manually, or " +
      "DuoSpaceLocationService.kt will fail to compile with unresolved gms.location references.",
    );
    return;
  }
  const insertAt = depsMatch.index + depsMatch[0].length;
  source = source.slice(0, insertAt) +
    // Version pinned to match native-plugins/background-geolocation/android/build.gradle exactly.
    "    implementation \"com.google.android.gms:play-services-location:21.3.0\"\n" +
    source.slice(insertAt);
  writeFileSync(ANDROID_APP_GRADLE, source, "utf8");
  console.log("[patch-native-permissions] Android: added play-services-location dependency to app/build.gradle (required by DuoSpaceLocationService.kt).");
}

/**
 * FIX (confirmed via a real APKForge CI build — :app:compileReleaseKotlin
 * FAILED with ~30 "Unresolved reference" errors, all in
 * CallNotificationService.kt: FirebaseMessagingService, RemoteMessage,
 * onMessageReceived/onNewToken not overriding anything, etc.):
 *
 * CallNotificationService.kt (copied into app/src/main/java/com/duospace/app/
 * by copyNativeKotlinSources(), same as DuoSpaceLocationService.kt above)
 * imports com.google.firebase.messaging.FirebaseMessagingService /
 * RemoteMessage directly. firebase-messaging IS already a dependency in
 * this project — but only transitively, inside whatever Capacitor's own
 * @capacitor/push-notifications Android module declares it as (also
 * `implementation` scope, same non-transitive story as
 * play-services-location above). The app module's own Kotlin source has
 * no visibility into it, hence "Unresolved reference" rather than a
 * version conflict.
 *
 * Fix: declare firebase-messaging directly on the app module via the
 * Firebase BOM (Google's recommended pattern — lets Gradle pick a
 * messaging version consistent with whatever else on the merged
 * classpath pulls in Firebase, instead of hand-pinning a version here
 * that could drift from the one bundled inside @capacitor/push-notifications).
 */
function patchAppGradleForFirebaseMessaging() {
  if (!existsSync(ANDROID_APP_GRADLE)) {
    console.log("[patch-native-permissions] Skipping Firebase Messaging app-module patch — android/app/build.gradle not found (run `npx cap add android` first).");
    return;
  }
  let source = readFileSync(ANDROID_APP_GRADLE, "utf8");

  if (/com\.google\.firebase:firebase-messaging/.test(source)) {
    console.log("[patch-native-permissions] android/app/build.gradle already depends on firebase-messaging.");
    return;
  }

  const depsMatch = source.match(/dependencies\s*\{[ \t]*\n/);
  if (!depsMatch) {
    console.warn(
      "[patch-native-permissions] Could not find a `dependencies {` block in android/app/build.gradle — " +
      "add `implementation platform(\"com.google.firebase:firebase-bom:33.7.0\")` and " +
      "`implementation \"com.google.firebase:firebase-messaging\"` manually, or " +
      "CallNotificationService.kt will fail to compile with unresolved firebase.messaging references.",
    );
    return;
  }
  const insertAt = depsMatch.index + depsMatch[0].length;
  source = source.slice(0, insertAt) +
    "    implementation platform(\"com.google.firebase:firebase-bom:33.7.0\")\n" +
    "    implementation \"com.google.firebase:firebase-messaging\"\n" +
    source.slice(insertAt);
  writeFileSync(ANDROID_APP_GRADLE, source, "utf8");
  console.log("[patch-native-permissions] Android: added firebase-messaging dependency (via Firebase BOM) to app/build.gradle (required by CallNotificationService.kt).");
}

/**
 * ROOT CAUSE (reported by user: "after signing in ... app just crashes ...
 * doesn't open again"):
 *
 * The firebase-messaging *library* patch above fixes compilation, but
 * Firebase also needs to be *initialized* at runtime, which on Android
 * happens automatically via a ContentProvider that reads
 * android/app/google-services.json — a file scoped to a specific Firebase
 * project (matching the FIREBASE_PROJECT_ID already configured as a
 * Supabase secret per PUSH_NOTIFICATIONS.md) and applied via the
 * com.google.gms.google-services Gradle plugin. Neither has ever existed
 * anywhere in this repo.
 *
 * Without it, FirebaseApp is never initialized. usePushNotifications.ts
 * calls PushNotifications.register() as soon as `user` becomes truthy —
 * i.e. immediately after a successful sign-in — which internally calls
 * FirebaseMessaging.getInstance(), which throws
 * `IllegalStateException: Default FirebaseApp is not initialized` on the
 * native side. That's a native crash, not a JS one, so none of the
 * try/catch blocks in usePushNotifications.ts or the OAuth deep-link
 * handler can catch it — consistent with "no warning nothing". And since
 * the session is already persisted (see capacitorAuthStorage.ts) by the
 * time this fires, `user` is truthy again on the very next cold start,
 * re-triggering the same registration call and the same crash before the
 * user can ever get past it — consistent with "doesn't open again".
 *
 * This function wires up the plugin + config file, gated on the config
 * file actually existing (see copyGoogleServicesConfig below), so that:
 *   - before you add the file: nothing changes here, and the runtime
 *     crash above still needs the file to be fixed (there's no way
 *     around actually needing your Firebase project's config);
 *   - once you drop your project's google-services.json at
 *     native/android/google-services.json (same staging pattern as
 *     every other native/android/* file in this repo) and rebuild: this
 *     wires itself in automatically, and if the file is ever missing or
 *     malformed on some future run, the google-services Gradle plugin
 *     fails the BUILD with a clear message instead of shipping an APK
 *     that crashes on-device after sign-in.
 *
 * To get the file: Firebase Console → Project Settings → your Android
 * app (package app.duospace, create it if it doesn't exist yet) →
 * download google-services.json.
 */
function copyGoogleServicesConfig() {
  if (!existsSync(join(ROOT, "android"))) {
    console.log("[patch-native-permissions] Skipping google-services.json — android/ not found (run `npx cap add android` first).");
    return false;
  }
  if (!existsSync(NATIVE_GOOGLE_SERVICES_JSON)) {
    console.warn(
      "[patch-native-permissions] native/android/google-services.json not found — Firebase will NOT be " +
      "initialized on Android, so PushNotifications.register() (called right after sign-in, see " +
      "usePushNotifications.ts) will crash the app natively with 'Default FirebaseApp is not initialized'. " +
      "Download this file from Firebase Console (Project Settings → your Android app, package app.duospace) " +
      "and place it at native/android/google-services.json to fix push notifications on Android.",
    );
    return false;
  }
  copyFileSync(NATIVE_GOOGLE_SERVICES_JSON, ANDROID_APP_GOOGLE_SERVICES_JSON);
  console.log("[patch-native-permissions] Android: copied google-services.json into app/.");
  return true;
}

function patchGradleForGoogleServicesPlugin() {
  if (!existsSync(ANDROID_APP_GOOGLE_SERVICES_JSON)) {
    console.log("[patch-native-permissions] Skipping google-services Gradle plugin — google-services.json not staged yet (see warning above).");
    return;
  }

  if (existsSync(ANDROID_ROOT_GRADLE)) {
    let root = readFileSync(ANDROID_ROOT_GRADLE, "utf8");
    if (!/com\.google\.gms:google-services/.test(root)) {
      const depsMatch = root.match(/dependencies\s*\{[ \t]*\n/);
      if (depsMatch) {
        const insertAt = depsMatch.index + depsMatch[0].length;
        root = root.slice(0, insertAt) + "        classpath \"com.google.gms:google-services:4.4.2\"\n" + root.slice(insertAt);
        writeFileSync(ANDROID_ROOT_GRADLE, root, "utf8");
        console.log("[patch-native-permissions] Android: added google-services classpath to root build.gradle.");
      } else {
        console.warn("[patch-native-permissions] Could not find a `dependencies {` block in android/build.gradle for the google-services classpath — add it manually.");
      }
    } else {
      console.log("[patch-native-permissions] android/build.gradle already has the google-services classpath.");
    }
  }

  if (existsSync(ANDROID_APP_GRADLE)) {
    let source = readFileSync(ANDROID_APP_GRADLE, "utf8");
    if (!/apply\s+plugin:\s*['"]com\.google\.gms\.google-services['"]/.test(source)) {
      source = source + "\napply plugin: 'com.google.gms.google-services'\n";
      writeFileSync(ANDROID_APP_GRADLE, source, "utf8");
      console.log("[patch-native-permissions] Android: applied google-services plugin to app/build.gradle — FirebaseApp now initializes at runtime.");
    } else {
      console.log("[patch-native-permissions] app/build.gradle already applies the google-services plugin.");
    }
  }
}

/**
 * FIX (confirmed via a real APKForge CI build — :app:compileReleaseKotlin
 * FAILED with "Class 'kotlin.Unit' was compiled with an incompatible
 * version of Kotlin. The actual metadata version is 2.1.0, but the
 * compiler version 1.9.0 can read versions up to 2.0.0", plus a wave of
 * knock-on "Unresolved reference" errors for plain stdlib calls like
 * `apply`, `putString`, `Unit` in NotificationChannels.kt / TelecomHelper.kt):
 *
 * Adding firebase-messaging (above) transitively pulls
 * `kotlinx-coroutines-play-services:1.10.2` into the :app module — a
 * version compiled against Kotlin 2.1 metadata. APKForge's
 * NATIVE_MODULE_COMPILE step back-fills kotlin-gradle-plugin 1.9.25 into
 * the generated root android/build.gradle whenever it doesn't already
 * see a "kotlin-gradle-plugin" string there (see the REPAIR log line),
 * which is a 1.9.x compiler and can't read that 2.1 metadata. This is
 * the exact same shape of problem patch-native-kotlin-versions.mjs
 * already solved for @capacitor/camera, @capacitor/filesystem, and
 * @capacitor/geolocation via a per-module resolutionStrategy force
 * block — that fix "WORKED" per its own comments and is deliberately
 * scoped low rather than raised, since an older stdlib read by whichever
 * compiler eventually applies (1.9.25 or 2.1.0) is always safe. That
 * script only touches node_modules/<pkg>/android/build.gradle, though —
 * it has no reach into android/app/build.gradle, which is where the
 * firebase-messaging dependency (and therefore this stdlib version) now
 * actually lives. Applying the identical force block directly to the
 * app module here, rather than trying to make patch-native-kotlin-versions.mjs
 * reach across into a file it doesn't otherwise own.
 */
function patchAppGradleForKotlinStdlibVersions() {
  if (!existsSync(ANDROID_APP_GRADLE)) {
    console.log("[patch-native-permissions] Skipping Kotlin stdlib version pin — android/app/build.gradle not found (run `npx cap add android` first).");
    return;
  }
  let source = readFileSync(ANDROID_APP_GRADLE, "utf8");
  const MARKER = "PATCHED by scripts/patch-native-permissions.mjs (Kotlin stdlib version pin)";
  if (source.includes(MARKER)) {
    console.log("[patch-native-permissions] android/app/build.gradle already has the Kotlin stdlib version pin.");
    return;
  }

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
  const forceBlock =
    `\n// ---- ${MARKER} ----\n` +
    "// firebase-messaging (added above) transitively pulls in kotlinx-coroutines-play-services\n" +
    "// built against Kotlin 2.1 metadata, which APKForge's 1.9.25 compiler back-fill can't read.\n" +
    "// Same fix already proven for @capacitor/camera/filesystem/geolocation in\n" +
    "// scripts/patch-native-kotlin-versions.mjs, applied here to the app module directly.\n" +
    "configurations.all {\n" +
    "    resolutionStrategy {\n" +
    "        force(\n" +
    Object.entries(FORCED_VERSIONS)
      .map(([module, version]) => `            "${module}:${version}"`)
      .join(",\n") +
    "\n        )\n" +
    "    }\n" +
    "}\n" +
    "// ---- end patch ----\n";

  source = source + forceBlock;
  writeFileSync(ANDROID_APP_GRADLE, source, "utf8");
  console.log("[patch-native-permissions] Android: forced kotlin-stdlib/kotlinx-coroutines-* to Kotlin-1.9-readable versions in app/build.gradle (required now that firebase-messaging pulls kotlinx-coroutines-play-services 2.1-metadata into :app).");
}

function enforceBundleIdentifier() {
  if (existsSync(IOS_PBXPROJ)) {
    const before = readFileSync(IOS_PBXPROJ, "utf8");
    const after = before.replace(
      /PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/g,
      `PRODUCT_BUNDLE_IDENTIFIER = ${APP_PACKAGE};`,
    );
    if (after !== before) {
      writeFileSync(IOS_PBXPROJ, after, "utf8");
      console.log(`[patch-native-permissions] iOS: PRODUCT_BUNDLE_IDENTIFIER pinned to ${APP_PACKAGE}.`);
    } else {
      console.log(`[patch-native-permissions] iOS: bundle identifier already ${APP_PACKAGE}.`);
    }
  } else {
    console.log("[patch-native-permissions] Skipping iOS bundle id — ios/ project not generated yet.");
  }

  if (existsSync(ANDROID_APP_GRADLE)) {
    const before = readFileSync(ANDROID_APP_GRADLE, "utf8");
    let after = before.replace(/applicationId\s+"[^"]*"/g, `applicationId "${APP_PACKAGE}"`);
    after = after.replace(/namespace\s+"[^"]*"/g, `namespace "${APP_PACKAGE}"`);
    if (after !== before) {
      writeFileSync(ANDROID_APP_GRADLE, after, "utf8");
      console.log(`[patch-native-permissions] Android: applicationId/namespace pinned to ${APP_PACKAGE}.`);
    } else {
      console.log(`[patch-native-permissions] Android: applicationId already ${APP_PACKAGE}.`);
    }
  } else {
    console.log("[patch-native-permissions] Skipping Android applicationId — android/ project not generated yet.");
  }
}

patchIosPlist();
patchIosEntitlements();
patchAndroidManifest();
copyNativeKotlinSources();
patchAppGradleForKotlin();
patchAppGradleForLocationServices();
patchAppGradleForFirebaseMessaging();
patchAppGradleForKotlinStdlibVersions();
copyGoogleServicesConfig();
patchGradleForGoogleServicesPlugin();
copyNotificationSoundAssets();
copyNotificationIconAsset();
copyNativeSwiftSources();
patchIosAppDelegate();
patchMainActivity();
patchAndroidSettingsGradle();
enforceBundleIdentifier();
console.log("[patch-native-permissions] Done. Rebuild the native app (Xcode / Android Studio) for changes to take effect.");

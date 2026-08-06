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
 * This script is idempotent — safe to run repeatedly, and safe to run
 * before the native projects exist (it just skips with a clear message).
 * Run it after every `cap add` and every `cap sync`.
 *
 * Usage:
 *   node scripts/patch-native-permissions.mjs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
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
];

const ANDROID_PERMISSIONS = [
  "android.permission.CAMERA",
  "android.permission.RECORD_AUDIO",
  "android.permission.INTERNET",
  // --- FCM push / incoming-call notifications ---
  "android.permission.POST_NOTIFICATIONS", // Android 13+ runtime notification permission
  "android.permission.USE_FULL_SCREEN_INTENT", // Android 14+ requires this declared explicitly
  "android.permission.VIBRATE",
  "android.permission.WAKE_LOCK",
  "android.permission.FOREGROUND_SERVICE",
  "android.permission.FOREGROUND_SERVICE_PHONE_CALL", // Android 14+ foreground service type grant
  // --- Media / photo library (Android 13+ granular replacements for
  //     READ_EXTERNAL_STORAGE; the legacy ones below are sdk-capped) ---
  "android.permission.READ_MEDIA_IMAGES",
  "android.permission.READ_MEDIA_VIDEO",
  "android.permission.READ_MEDIA_VISUAL_USER_SELECTED", // Android 14 partial photo access
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
const NATIVE_KOTLIN_FILES = ["NotificationChannels.kt", "CallNotificationService.kt", "CallRingingService.kt"];
const MAIN_ACTIVITY_KT = join(ANDROID_JAVA_SRC_DIR, "MainActivity.kt");
const MAIN_ACTIVITY_JAVA = join(ANDROID_JAVA_SRC_DIR, "MainActivity.java");

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
      `    <meta-data\n` +
      `        android:name="com.google.firebase.messaging.default_notification_channel_id"\n` +
      `        android:value="duospace_messages" />\n`;
    const appCloseIdx = manifest.lastIndexOf("</application>");
    if (appCloseIdx === -1) {
      console.warn("[patch-native-permissions] Could not find </application> in AndroidManifest.xml — add the push services manually.");
    } else {
      manifest = manifest.slice(0, appCloseIdx) + servicesBlock + manifest.slice(appCloseIdx);
      changed = true;
      console.log("[patch-native-permissions] Android: registered CallNotificationService + CallRingingService, and the default FCM channel.");
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
        logIfOAuthCallback(intent, "onCreate")
        handleDuospaceCallIntent(intent)
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

function patchMainActivity() {
  if (existsSync(MAIN_ACTIVITY_JAVA)) {
    console.warn(
      "[patch-native-permissions] MainActivity.java found (Java template) — automatic patching only supports the Kotlin template. " +
      "See PUSH_NOTIFICATIONS.md \u00a7 'Manual MainActivity.java integration' for the equivalent Java snippet to add by hand.",
    );
    return;
  }
  if (!existsSync(MAIN_ACTIVITY_KT)) {
    console.log("[patch-native-permissions] Skipping MainActivity patch — MainActivity.kt not found (run `npx cap add android` first).");
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

patchIosPlist();
patchAndroidManifest();
copyNativeKotlinSources();
patchMainActivity();
console.log("[patch-native-permissions] Done. Rebuild the native app (Xcode / Android Studio) for changes to take effect.");

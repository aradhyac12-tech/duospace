import { Capacitor } from "@capacitor/core";
import { prefs } from "@/lib/prefs";
import { logError } from "@/lib/telemetry";

/**
 * Supabase auth storage adapter backed by @capacitor/preferences (Android
 * SharedPreferences / iOS UserDefaults) instead of WebView localStorage.
 *
 * Why this matters specifically for the OAuth round-trip:
 *
 * signInWithOAuth() with flowType: 'pkce' writes the code_verifier to
 * storage, then — on the very next tick — hands off to the system browser,
 * which means the app is about to be backgrounded. On Android, a
 * WebView's localStorage write is not a synchronous disk write; it's
 * Chromium's own storage backend, flushed to disk on its own schedule. If
 * the OS reclaims the app's process for memory (exactly what tends to
 * happen while a heavyweight Custom Tab / browser is in the foreground)
 * before that flush completes, the code_verifier is gone. The app comes
 * back via the duospace://auth callback, calls exchangeCodeForSession(),
 * and it fails — "session never completes" is the visible symptom, but the
 * actual cause is a lost localStorage write during the highest-risk moment
 * of the entire flow, not the Activity/Intent handling itself.
 *
 * @capacitor/preferences writes go straight to native SharedPreferences
 * through the bridge — a synchronous native file write on Android, not
 * batched WebView storage — so it survives process death far more reliably
 * than localStorage during exactly this window.
 *
 * This was already the documented intent (see BUILD.md: "Auth session uses
 * @capacitor/preferences on native, not localStorage") and src/lib/storage.ts
 * already pointed here — client.ts just wasn't actually wired up to it.
 *
 * FIX (Android reliability audit): the generic `prefs` wrapper (lib/prefs.ts)
 * is deliberately best-effort — it silently degrades to localStorage when
 * the native Preferences plugin is unavailable or times out, which is the
 * right call for ordinary app settings but is exactly wrong here: silently
 * falling back to localStorage for PKCE storage on native Android
 * re-introduces the precise code_verifier-loss race this adapter exists to
 * avoid, with no signal that it happened — "session never completes" would
 * come back as an unexplained, intermittent failure instead of a diagnosable
 * one. On native Android specifically, this adapter now bypasses that
 * fallback entirely and calls @capacitor/preferences directly: if the plugin
 * is missing, half-registered, or times out, it throws instead of degrading.
 * That surfaces as a loud, logged, catchable error in the OAuth flow (see
 * Auth.tsx's deep-link handler, which already logs and toasts on any thrown
 * error) rather than a silent, hard-to-reproduce storage downgrade.
 * iOS and web are unchanged — both keep going through the shared `prefs`
 * wrapper with its existing localStorage fallback, since this audit is
 * scoped to Android native reliability only.
 */

const ANDROID_PREFS_TIMEOUT_MS = 2500;

class AndroidPreferencesUnavailableError extends Error {
  constructor(cause: string) {
    super(
      `@capacitor/preferences is unavailable on native Android (${cause}). ` +
      `PKCE/session storage will NOT silently fall back to localStorage on ` +
      `Android, since that would reintroduce the code_verifier-loss race the ` +
      `OAuth flow depends on this plugin to avoid. Fix the native Preferences ` +
      `registration (re-run \`npm run cap:sync\`, verify android/capacitor.settings.gradle ` +
      `wires in node_modules/@capacitor/preferences, and check ` +
      `android/app/src/main/assets/capacitor.plugins.json lists it) rather than ` +
      `catching this and continuing.`,
    );
    this.name = "AndroidPreferencesUnavailableError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new AndroidPreferencesUnavailableError(`${label} timed out after ${ms}ms — bridge call never returned`)),
      ms,
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** True only for native Android — iOS/web keep using the shared `prefs` wrapper unchanged. */
function isNativeAndroid(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

let androidPluginPromise: Promise<typeof import("@capacitor/preferences").Preferences> | null = null;
async function resolveAndroidPreferencesPlugin() {
  if (!androidPluginPromise) {
    androidPluginPromise = (async () => {
      const { Preferences } = await import("@capacitor/preferences");
      if (!Capacitor.isPluginAvailable("Preferences")) {
        throw new AndroidPreferencesUnavailableError("Capacitor.isPluginAvailable('Preferences') returned false");
      }
      return Preferences;
    })();
  }
  return androidPluginPromise;
}

async function androidGet(key: string): Promise<string | null> {
  const plugin = await resolveAndroidPreferencesPlugin();
  const { value } = await withTimeout(plugin.get({ key }), ANDROID_PREFS_TIMEOUT_MS, "Preferences.get()");
  return value;
}
async function androidSet(key: string, value: string): Promise<void> {
  const plugin = await resolveAndroidPreferencesPlugin();
  await withTimeout(plugin.set({ key, value }), ANDROID_PREFS_TIMEOUT_MS, "Preferences.set()");
}
async function androidRemove(key: string): Promise<void> {
  const plugin = await resolveAndroidPreferencesPlugin();
  await withTimeout(plugin.remove({ key }), ANDROID_PREFS_TIMEOUT_MS, "Preferences.remove()");
}

export const capacitorAuthStorage = {
  async getItem(key: string): Promise<string | null> {
    if (isNativeAndroid()) {
      try {
        return await androidGet(key);
      } catch (err) {
        logError("auth.storage", "native Android Preferences.get() failed — not falling back to localStorage", { key, err: String(err) });
        throw err;
      }
    }
    return prefs.get(key);
  },
  async setItem(key: string, value: string): Promise<void> {
    if (isNativeAndroid()) {
      try {
        await androidSet(key, value);
        return;
      } catch (err) {
        logError("auth.storage", "native Android Preferences.set() failed — not falling back to localStorage", { key, err: String(err) });
        throw err;
      }
    }
    await prefs.set(key, value);
  },
  async removeItem(key: string): Promise<void> {
    if (isNativeAndroid()) {
      try {
        await androidRemove(key);
        return;
      } catch (err) {
        logError("auth.storage", "native Android Preferences.remove() failed — not falling back to localStorage", { key, err: String(err) });
        throw err;
      }
    }
    await prefs.remove(key);
  },
};

/**
 * Safe wrapper around @capacitor/preferences.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every direct `Preferences.get/set(...)` call throws
 * `"Preferences" plugin is not implemented on android` when the native
 * plugin isn't registered in the current build — which happens more often
 * than it should: a stale `npx cap sync`, a debug APK built before the
 * plugin was added, or simply running the web bundle inside a WebView
 * shell. Those throws were not caught at the call sites, so a missing
 * plugin took down things that had nothing to do with storage: the auth
 * session adapter (blank screen / stuck sign-in) and device-id resolution
 * for push registration.
 *
 * This wrapper resolves the plugin lazily, once, and transparently falls
 * back to localStorage when it isn't available or a call fails. Storage is
 * best-effort by nature — losing a preference is survivable, crashing the
 * app over one is not.
 *
 * IMPORTANT CAVEAT — this fallback is NOT a substitute for the native
 * plugin actually working, specifically for the OAuth round-trip. See
 * capacitorAuthStorage.ts: the whole reason auth storage uses
 * @capacitor/preferences instead of localStorage is that Preferences
 * writes go straight to native SharedPreferences (synchronous, survives
 * process death), while a WebView localStorage write is async/batched and
 * can be lost if the OS reclaims the app's process while the system
 * browser is in the foreground for Google's consent screen. If Preferences
 * is unavailable, this wrapper falls back to that same less-durable
 * localStorage silently (by original design, to avoid crashing on a
 * missing plugin) — which means a broken Preferences registration doesn't
 * fail loudly, it just quietly re-introduces the exact code_verifier-loss
 * race PKCE storage was moved off localStorage to avoid.
 *
 * DEEPER BUG FOUND — this is the one that actually explains sign-in AND
 * sign-up AND OAuth all appearing to "do nothing" (not just OAuth): every
 * catch block below only guarded against the native call REJECTING. A
 * half-registered plugin (present in capacitor.plugins.json / the JS proxy
 * exists, but its Android class is missing/broken — see
 * patch-native-permissions.mjs's patchAndroidSettingsGradle for the
 * mechanics) doesn't necessarily reject fast — the Capacitor bridge message
 * can simply never come back, leaving the call permanently pending.
 * `@supabase/supabase-js`'s GoTrueClient AWAITS this exact storage.setItem()
 * call as part of `_saveSession()`, and only fires the `SIGNED_IN`
 * `onAuthStateChange` event — and only resolves the outer
 * `signInWithPassword()`/`signUp()`/`exchangeCodeForSession()` promise
 * itself — *after* that completes. A hang here doesn't throw, doesn't
 * toast, doesn't log an error: sign-in "succeeds" against the network tab
 * but the app never hears about it and the button spins forever. This is
 * the actual root cause for the generalized "sign in / sign up / OAuth
 * callback all not working" report, not just a PKCE-specific storage race.
 *
 * Every native call below is now raced against a hard timeout so it can
 * never block the caller (and therefore never block GoTrueClient, and
 * therefore never block the whole auth flow) indefinitely. Once a timeout
 * is observed, the plugin is marked dead for the rest of this session so
 * later calls skip straight to localStorage instead of paying the timeout
 * again on every read/write.
 */

import { logWarn } from "@/lib/telemetry";

const NATIVE_CALL_TIMEOUT_MS = 2500;

type PrefsPlugin = {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
};

let pluginPromise: Promise<PrefsPlugin | null> | null = null;
// Flips true the first time any native call times out or throws — once a
// bridge call has proven unreliable, stop trusting it for the rest of this
// session rather than re-risking a multi-second stall on every subsequent
// read/write (which, per the SIGNED_IN gating above, means every
// subsequent auth check too).
let pluginDead = false;

class NativeCallTimeout extends Error {
  constructor() { super("native Preferences call timed out"); this.name = "NativeCallTimeout"; }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new NativeCallTimeout()), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function resolvePlugin(): Promise<PrefsPlugin | null> {
  if (pluginDead) return null;
  if (!pluginPromise) {
    pluginPromise = (async () => {
      try {
        const [{ Capacitor }, { Preferences }] = await Promise.all([
          import("@capacitor/core"),
          import("@capacitor/preferences"),
        ]);
        // isPluginAvailable() is the only reliable pre-flight check — on a
        // build without the native plugin the JS proxy still exists and
        // only throws once you call it.
        if (!Capacitor.isPluginAvailable("Preferences")) {
          if (Capacitor.isNativePlatform()) {
            logWarn("prefs", "Preferences unavailable on native platform — falling back to localStorage for all reads/writes, including auth session/PKCE storage", {
              platform: Capacitor.getPlatform(),
            });
          }
          return null;
        }
        return Preferences as unknown as PrefsPlugin;
      } catch {
        return null;
      }
    })();
  }
  return pluginPromise;
}

const webGet = (key: string): string | null => {
  try { return localStorage.getItem(key); } catch { return null; }
};
const webSet = (key: string, value: string): void => {
  try { localStorage.setItem(key, value); } catch { /* quota / private mode */ }
};
const webRemove = (key: string): void => {
  try { localStorage.removeItem(key); } catch { /* noop */ }
};

export const prefs = {
  async get(key: string): Promise<string | null> {
    const plugin = await resolvePlugin();
    if (plugin) {
      try {
        const { value } = await withTimeout(plugin.get({ key }), NATIVE_CALL_TIMEOUT_MS);
        // Fall back to any value written while the plugin was unavailable.
        return value ?? webGet(key);
      } catch (err) {
        const timedOut = err instanceof NativeCallTimeout;
        logWarn("prefs", `Preferences.get() ${timedOut ? "timed out" : "threw"} — falling back to localStorage`, { key, timedOut, err: String(err) });
        if (timedOut) pluginDead = true;
        return webGet(key);
      }
    }
    return webGet(key);
  },

  async set(key: string, value: string): Promise<void> {
    const plugin = await resolvePlugin();
    if (plugin) {
      try {
        await withTimeout(plugin.set({ key, value }), NATIVE_CALL_TIMEOUT_MS);
        return;
      } catch (err) {
        const timedOut = err instanceof NativeCallTimeout;
        logWarn("prefs", `Preferences.set() ${timedOut ? "timed out" : "threw"} — falling back to localStorage`, { key, timedOut, err: String(err) });
        if (timedOut) pluginDead = true;
      }
    }
    webSet(key, value);
  },

  async remove(key: string): Promise<void> {
    const plugin = await resolvePlugin();
    if (plugin) {
      try {
        await withTimeout(plugin.remove({ key }), NATIVE_CALL_TIMEOUT_MS);
      } catch (err) {
        if (err instanceof NativeCallTimeout) pluginDead = true;
        /* fall through */
      }
    }
    // Always clear the web copy too, so a stale fallback value can't
    // resurrect a "removed" key on the next get().
    webRemove(key);
  },
};

export default prefs;

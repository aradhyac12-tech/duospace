import { Preferences } from "@capacitor/preferences";

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
 */
export const capacitorAuthStorage = {
  async getItem(key: string): Promise<string | null> {
    const { value } = await Preferences.get({ key });
    return value ?? null;
  },
  async setItem(key: string, value: string): Promise<void> {
    await Preferences.set({ key, value });
  },
  async removeItem(key: string): Promise<void> {
    await Preferences.remove({ key });
  },
};

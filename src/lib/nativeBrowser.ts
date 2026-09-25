import { Capacitor } from "@capacitor/core";
import { logInfo, logWarn } from "@/lib/telemetry";

/**
 * Thin, always-safe wrapper around `@capacitor/browser`.
 *
 * Why this exists: the JS package can be installed while the *native* plugin
 * is not registered in the Android/iOS project (this happens whenever the
 * native folders were generated before the dependency was added and
 * `npx cap sync` hasn't been re-run). In that state every call rejects with
 *   "Browser" plugin is not implemented on android
 * which, before this wrapper, aborted the whole Google OAuth flow.
 *
 * Opening the URL is essential; opening it *in an in-app browser* is not.
 * So we degrade gracefully to a plain top-level navigation, which on a
 * Capacitor WebView hands the URL to the system browser and still comes back
 * through the `duospace://auth` deep link.
 *
 * ROOT CAUSE (found via screen-recording analysis, 2026-08-21): Google login
 * would open, the account picker would show, and right as the account was
 * tapped (Google processing the redirect) the tab would visibly slide away
 * and close — before `duospace://auth` was ever delivered. No JS callback
 * code ever ran (no "Completing sign in" state, no log line, no toast)
 * because there was no deep link to receive — the tab was dismissed, not
 * redirected.
 *
 * `presentationStyle: "popover"` is an iOS-only concept (a small dismissible
 * sheet/formsheet). On Android, @capacitor/browser maps it to a Custom Tab
 * presented as a swipe-dismissible sheet instead of a normal stable full
 * Custom Tab — so any stray drag/momentum on the shrinking account-picker UI
 * right as Google is about to redirect closes the tab prematurely and
 * silently abandons the OAuth flow. This never affects iOS (where popover is
 * the correct, intended presentation) — only Android needs a full, non-
 * dismissible-by-swipe Custom Tab so the redirect has time to complete.
 */

function isUnimplemented(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /not implemented|unimplemented|not available|UNIMPLEMENTED/i.test(msg);
}

/** Open an external URL, preferring the in-app browser when it really works. */
export async function openExternalUrl(url: string): Promise<"plugin" | "fallback"> {
  try {
    const { Browser } = await import("@capacitor/browser");
    // presentationStyle only applies on iOS, where "popover" is intended and
    // safe. Passing it on Android produces a dismissible sheet that can be
    // swiped away mid-redirect (see root-cause note above) — omit it there
    // so Android gets the plugin's normal full, stable Custom Tab.
    const platform = Capacitor.getPlatform();
    await Browser.open(
      platform === "ios" ? { url, presentationStyle: "popover" } : { url },
    );
    return "plugin";
  } catch (err) {
    logWarn("native.browser", "Browser.open unavailable — falling back to top-level navigation", {
      reason: isUnimplemented(err) ? "plugin_not_implemented" : "plugin_error",
      message: err instanceof Error ? err.message : String(err),
    });
    // Top-level navigation: on native this leaves the WebView and opens the
    // system browser; on web it's the normal OAuth redirect.
    window.location.href = url;
    return "fallback";
  }
}

/** Close the in-app browser if (and only if) one was actually opened. */
export async function closeExternalBrowser(): Promise<void> {
  try {
    const { Browser } = await import("@capacitor/browser");
    await Browser.close();
    logInfo("native.browser", "in-app browser closed", {});
  } catch {
    /* Not implemented, not installed, or nothing open — never fatal. */
  }
}

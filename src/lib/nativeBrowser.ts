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
 */

function isUnimplemented(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /not implemented|unimplemented|not available|UNIMPLEMENTED/i.test(msg);
}

/** Open an external URL, preferring the in-app browser when it really works. */
export async function openExternalUrl(url: string): Promise<"plugin" | "fallback"> {
  try {
    const { Browser } = await import("@capacitor/browser");
    await Browser.open({ url, presentationStyle: "popover" });
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

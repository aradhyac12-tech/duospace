import { useEffect, useRef } from "react";
import { Capacitor } from "@capacitor/core";
import { logWarn } from "@/lib/telemetry";

/**
 * Hides the native Capacitor splash (config: capacitor.config.json has
 * `launchAutoHide: false` specifically so nothing auto-hides it) the moment
 * this component mounts — the earliest point in the React tree at which the
 * hand-off SplashScreen.tsx is actually on screen and ready to take over, so
 * there's no gap and no guessed duration.
 *
 * PHASE 2 FIX (permission wall at launch): this used to ALSO batch-request
 * camera, photos, microphone, files, notifications, and location — all six,
 * sequentially, right here, before the person had ever seen Chat. That's
 * exactly the "permission wall" this phase exists to remove, and auditing
 * where each one actually belongs turned up that every media kind already
 * has a real contextual home and this was purely redundant, not load-bearing:
 *
 *   - camera   → CameraWithFilters.tsx calls ensureMediaPermission("camera")
 *                the moment the camera actually opens.
 *   - photos   → Chat.tsx's attach-menu calls ensureMedia("photos") when the
 *                person taps "Photo", via useMediaPermission()/PermissionDeniedSheet.
 *   - files    → same attach-menu, ensureMedia("files") when they tap "File".
 *   - microphone → Chat.tsx/Calls.tsx call ensureCallMedia("microphone")
 *                right before a call actually starts.
 *   - location → gated behind `sharingActive` in LocationContext.tsx; the
 *                native background-location plugin requests permission
 *                itself when sharing is actually turned on, and degrades to
 *                foreground-only if declined rather than depending on this
 *                having run first.
 *   - notifications → usePushNotifications.ts requests its own permission
 *                independently of this hook already (see that file) — this
 *                was a genuine duplicate permission manager, asking twice.
 *
 * So removing the batch here doesn't leave anything ungated — it removes a
 * redundant, premature copy of requests that already happen contextually
 * everywhere they're actually needed. See docs for the specific audit that
 * found this.
 */
export function useLaunchPermissions() {
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    if (!Capacitor.isNativePlatform()) return;

    (async () => {
      try {
        const { SplashScreen } = await import("@capacitor/splash-screen");
        await SplashScreen.hide();
      } catch (e) {
        // Splash plugin not installed, or already hidden — either way there
        // is nothing left to do; SplashScreen.tsx's own hand-off frame
        // covers the visual regardless.
        logWarn("launch", "native splash hide skipped", e);
      }
    })();
  }, []);
}

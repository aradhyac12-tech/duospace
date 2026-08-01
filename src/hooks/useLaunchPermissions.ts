import { useEffect, useRef } from "react";
import { Capacitor } from "@capacitor/core";
import { logInfo, logWarn } from "@/lib/telemetry";
import { ensureMediaPermission } from "@/lib/mediaPermissions";

/**
 * Requests every native permission DuoSpace needs, once, right as the app
 * launches (Capacitor's splash screen has `launchAutoHide: true`, so by the
 * time this component mounts the splash is already gone — this is the
 * earliest point in the React tree to ask).
 *
 * Deliberately fire-and-forget and non-blocking: a denial here never gates
 * the UI. Every feature re-checks and re-requests through the same
 * `ensureMediaPermission` service at the point of use, and shows the shared
 * recovery sheet when denied — so declining here doesn't lock anyone out, it
 * just avoids a wall of separate prompts scattered across first-run.
 *
 * Web/PWA: no-op. Browsers only allow permission prompts to be triggered
 * from a user gesture in direct response to an API call (getUserMedia, etc.),
 * so an upfront batch-request on load either does nothing or gets silently
 * blocked — those flows keep asking in-context on web.
 */
export function useLaunchPermissions() {
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    if (!Capacitor.isNativePlatform()) return;

    const run = async () => {
      // Explicitly hide the splash before prompting, so the OS permission
      // dialogs never stack behind the splash image on slower devices.
      try {
        const { SplashScreen } = await import("@capacitor/splash-screen");
        await SplashScreen.hide();
      } catch {
        /* splash plugin not installed — carry on */
      }
      // Small settle delay so the first prompt doesn't collide with the
      // splash fade-out animation on iOS.
      await new Promise((r) => setTimeout(r, 300));

      // Media permissions, one at a time so the OS dialogs queue cleanly.
      // camera → photos (library read/write) → microphone → files.
      for (const kind of ["camera", "photos", "microphone", "files"] as const) {
        const r = await ensureMediaPermission(kind);
        logInfo("permissions", `launch ${kind} -> ${r.state}`);
      }

      // Push notifications.
      try {
        const { PushNotifications } = await import("@capacitor/push-notifications");
        const status = await PushNotifications.checkPermissions();
        if (status.receive !== "granted") {
          await PushNotifications.requestPermissions();
        }
        logInfo("permissions", "notifications requested on launch");
      } catch (e) {
        logWarn("permissions", "notification request failed on launch", e);
      }

      // Location — used by the shared map view.
      try {
        const { Geolocation } = await import("@capacitor/geolocation");
        const status = await Geolocation.checkPermissions();
        if (status.location !== "granted") {
          await Geolocation.requestPermissions();
        }
        logInfo("permissions", "location requested on launch");
      } catch (e) {
        logWarn("permissions", "location request failed on launch", e);
      }
    };

    run();
  }, []);
}

import { useEffect, useRef } from "react";
import { Capacitor } from "@capacitor/core";
import { logInfo, logWarn } from "@/lib/telemetry";

/**
 * Requests every native permission DuoSpace needs, once, right as the app
 * launches (Capacitor's splash screen has `launchAutoHide: true`, so by the
 * time this component mounts the splash is already gone — this is the
 * earliest point in the React tree to ask).
 *
 * Deliberately fire-and-forget and non-blocking: a denial here never gates
 * the UI. Each feature still re-checks/re-requests its own permission at the
 * point of use (see useLiveLocation, QRSignInScanner, usePushNotifications),
 * so declining here doesn't lock anyone out — it just avoids a wall of
 * separate prompts scattered across first-run.
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
      // Camera — used by the QR scanner and in-chat photo/video capture.
      try {
        const { Camera } = await import("@capacitor/camera");
        const status = await Camera.checkPermissions();
        if (status.camera !== "granted") {
          await Camera.requestPermissions({ permissions: ["camera"] });
        }
        logInfo("permissions", "camera requested on launch");
      } catch (e) {
        logWarn("permissions", "camera request failed on launch", e);
      }

      // Microphone — used by calls. There's no dedicated Capacitor
      // permission plugin for it; the standard way to trigger the native
      // prompt is a throwaway getUserMedia probe, immediately released.
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
        logInfo("permissions", "microphone requested on launch");
      } catch (e) {
        logWarn("permissions", "microphone request failed on launch", e);
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

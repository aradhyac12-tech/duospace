import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Capacitor } from "@capacitor/core";
import { MapPin, Settings2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { openAppSettings } from "@/lib/mediaPermissions";
import { useLocationContext } from "@/contexts/LocationContext";
import storage from "@/lib/storage";
import BackgroundLocationPrompt from "@/components/BackgroundLocationPrompt";
import { resolveColorMode } from "@/lib/themeEngine";
import type { ThemeModePreference, ColorMode } from "@/lib/themeEngine";

/**
 * PRODUCT DECISION (mandatory location): DuoSpace's whole premise is a
 * partner seeing your live location on the Map — unlike camera/mic/photos
 * (each optional, gated contextually right where the feature is used, see
 * useLaunchPermissions.ts), location has no meaningful "skip for now" path:
 * a couple with one side never sharing is a broken product for both of
 * them. So this is a hard gate, not a dismissible sheet: nothing under it
 * (Chat, Calls, the whole authenticated shell) mounts until
 * `myLocationPermission === "granted"`.
 *
 * Sits inside <LocationProvider> (App.tsx) so it reads the exact same
 * `live.permission` state machine LocationContext already exposes — no
 * separate permission-check logic to drift out of sync. LocationProvider's
 * own lifecycle effect already fires the real OS prompt automatically the
 * moment it mounts with a signed-in user (`sharingActive` is unconditional,
 * see LocationContext.tsx), so this component doesn't need to trigger a
 * request on mount itself — it only needs to block render until that
 * already-in-flight request resolves, and offer a manual retry / settings
 * deep-link for the "prompt closed without an answer" and "denied" cases.
 *
 * Background/foreground-service location prompts (the Android
 * DuoSpaceLocationService notification, ACCESS_BACKGROUND_LOCATION on
 * Android, "Always" on iOS) are a separate, later ask handled by the
 * background-geolocation plugin itself — this gate only enforces the
 * baseline foreground permission, which is enough to unblock the app.
 */

/**
 * FLASH FIX ("Location access required" appearing for an instant even though
 * permission was already granted): useLiveLocation's permission state starts
 * at "unknown" and only becomes "granted" once the async permission check
 * (a native bridge round trip on the APK) resolves. This gate used to treat
 * anything other than "granted" as "not allowed", so "unknown" — which just
 * means "still checking" — rendered the full "Location access required"
 * screen for however long that check took, on every launch.
 *
 * Now:
 *   - "unknown" is a distinct CHECKING state. It never shows the required-
 *     access screen.
 *   - If permission was confirmed granted on a previous launch (remembered in
 *     LAST_GRANTED_KEY), the app renders straight away while the check
 *     finishes. If it turns out to have been revoked, the state flips to
 *     "denied"/"prompt" and the gate takes over exactly as before.
 *   - First-ever launch (nothing remembered): a blank, theme-matched surface
 *     is shown while checking — no message, no button — so there's nothing to
 *     flash.
 *   - If the check somehow never resolves, CHECK_TIMEOUT_MS falls back to the
 *     normal gate so the person is never stuck on a blank screen.
 * The gate still blocks the app for "denied" and "prompt" — the mandatory-
 * location product decision above is unchanged.
 */
const LAST_GRANTED_KEY = "duo-location-permission-granted";
const CHECK_TIMEOUT_MS = 4000;

function readColorModeSync(): ColorMode {
  const manual = storage.get("duo-color-mode");
  const themeMode = (storage.get("duo-theme-mode") as ThemeModePreference | null) ?? (manual ? (manual as ColorMode) : "auto");
  const manualFallback: ColorMode = manual === "light" || manual === "dark" ? manual : "dark";
  return resolveColorMode(themeMode, {
    manualFallback,
    scheduleDarkStart: storage.get("duo-schedule-start") || "19:00",
    scheduleDarkEnd: storage.get("duo-schedule-end") || "07:00",
  });
}

export function LocationAccessGate({ children }: { children: ReactNode }) {
  const { myLocationPermission, retryLocationPermission } = useLocationContext();
  const [busy, setBusy] = useState(false);
  const [checkTimedOut, setCheckTimedOut] = useState(false);
  // Read once, synchronously, so the very first render already knows.
  const [wasGrantedBefore] = useState(() => storage.get(LAST_GRANTED_KEY) === "1");

  const checking = myLocationPermission === "unknown";

  // Remember the last CONFIRMED answer (never the transient "unknown").
  useEffect(() => {
    if (myLocationPermission === "granted") storage.set(LAST_GRANTED_KEY, "1");
    else if (myLocationPermission === "denied" || myLocationPermission === "prompt") storage.remove(LAST_GRANTED_KEY);
  }, [myLocationPermission]);

  // Safety net: never sit on the checking state forever.
  useEffect(() => {
    if (!checking) { setCheckTimedOut(false); return; }
    const t = window.setTimeout(() => setCheckTimedOut(true), CHECK_TIMEOUT_MS);
    return () => window.clearTimeout(t);
  }, [checking]);

  const isDark = readColorModeSync() === "dark";
  const background = isDark ? "#121316" : "#F6F6F9";
  const textColor = isDark ? "rgba(255,255,255,0.95)" : "rgba(20,20,24,0.92)";
  const mutedColor = isDark ? "rgba(255,255,255,0.6)" : "rgba(20,20,24,0.6)";

  const handleEnable = useCallback(async () => {
    setBusy(true);
    try {
      await retryLocationPermission();
    } finally {
      setBusy(false);
    }
  }, [retryLocationPermission]);

  const handleSettings = useCallback(async () => {
    setBusy(true);
    const opened = await openAppSettings();
    setBusy(false);
    if (!opened) void handleEnable();
  }, [handleEnable]);

  if (myLocationPermission === "granted") return <>{children}<BackgroundLocationPrompt /></>;

  if (checking && !checkTimedOut) {
    // Still checking — see FLASH FIX above. Known-good device: show the app.
    if (wasGrantedBefore) return <>{children}</>;
    return <div className="min-h-dvh" style={{ background }} aria-hidden="true" />;
  }

  const denied = myLocationPermission === "denied";

  return (
    <div className="min-h-dvh flex items-center justify-center px-6" style={{ background }}>
      <div className="flex flex-col items-center text-center max-w-xs">
        <div
          className="flex h-16 w-16 items-center justify-center rounded-full mb-5"
          style={{ background: "hsl(var(--primary) / 0.12)" }}
        >
          <MapPin className="h-7 w-7" style={{ color: "hsl(var(--primary))" }} aria-hidden="true" />
        </div>
        <p className="text-base font-semibold" style={{ color: textColor }}>
          Location access required
        </p>
        <p className="mt-2 text-sm" style={{ color: mutedColor }}>
          DuoSpace needs your location to work — it's how you and your partner
          stay connected on the map. {denied
            ? "You've turned this off, so the app can't continue."
            : "Please allow location access to continue."}
        </p>

        <div className="mt-6 w-full flex flex-col gap-2">
          {denied ? (
            <Button className="w-full rounded-xl" disabled={busy} onClick={handleSettings}>
              <Settings2 className="mr-2 h-4 w-4" aria-hidden="true" />
              {Capacitor.isNativePlatform() ? "Open settings" : "Try again"}
            </Button>
          ) : (
            <Button className="w-full rounded-xl" disabled={busy} onClick={handleEnable}>
              <MapPin className="mr-2 h-4 w-4" aria-hidden="true" />
              Enable location access
            </Button>
          )}
          {denied && (
            <Button variant="ghost" className="w-full rounded-xl" disabled={busy} onClick={handleEnable}>
              <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
              I've allowed it — retry
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export default LocationAccessGate;

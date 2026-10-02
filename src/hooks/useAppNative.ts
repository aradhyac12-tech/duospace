/**
 * useAppNative — native platform lifecycle:
 *   - Android hardware back button
 *   - App backgrounded → biometric lock
 *   - Network connectivity (online/offline/reconnecting pill)
 */
import { useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { useNavigate, useLocation } from "react-router-dom";
import { markAppBackgrounded, clearAppBackgroundedMark, shouldLockOnResume } from "@/lib/appLockTimer";
import { stopNativeMessageAlert } from "@/lib/messageAlert";

/**
 * Transient connection-status pill state (Lovable-style):
 *   "offline"      — persists the whole time we're definitely offline
 *   "reconnecting" — brief step right after connectivity returns, before
 *                    we call it good (mirrors the "still settling" moment
 *                    a real reconnect has — resubscribing channels etc.)
 *   "connected"    — brief confirmation flash once reconnecting settles
 *   null           — idle/steady-state online: nothing shown
 */
export type ConnectionStatus = "offline" | "reconnecting" | "connected" | null;

const RECONNECTING_MS = 900;
const CONNECTED_MS = 1600;

export const useAppNative = (
  isAppLocked: boolean,
  setIsAppLocked: (v: boolean) => void,
  biometricEnabled: boolean,
  // Minutes the app can sit backgrounded before this listener re-locks it —
  // shares lib/appLockTimer.ts's mark/check with ThemeContext's own
  // visibilitychange listener so the two redundant native-lifecycle paths
  // (this one via Capacitor appStateChange, ThemeContext's via
  // visibilitychange — both fire on native, kept as belt-and-suspenders)
  // never disagree about when "backgrounded long enough" actually is.
  // Defaults to 0 (instant lock) so an old caller that hasn't been updated
  // to pass this yet keeps today's behavior exactly.
  appLockTimeoutMinutes = 0,
  // ACCIDENTAL-EXIT FIX: whether a call is currently active/connecting —
  // see the backButton handler below. Optional/defaults to a function
  // returning false so an old caller that hasn't been updated yet keeps
  // today's behavior exactly. A function, not a plain boolean, so the
  // backButton closure (registered once, in the empty-deps effect below —
  // same pattern as every other value this hook reads via a ref) always
  // reads the CURRENT call state instead of whatever it was when the
  // listener was first registered.
  isCallActive: () => boolean = () => false,
  // Same reasoning: minimize instead of exit when there IS an active call.
  onMinimizeCall: () => void = () => {},
) => {
  const navigate = useNavigate();
  const location = useLocation();
  const [isOnline, setIsOnline] = useState(true);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(null);

  // Tracks whether we've ever seen a real offline moment, so the very first
  // "we're online" read on cold start doesn't play the reconnecting→connected
  // flourish — that's reserved for an actual recovery, not app launch.
  const sawOfflineRef = useRef(false);
  const reconnectTimersRef = useRef<{ toConnected?: ReturnType<typeof setTimeout>; toIdle?: ReturnType<typeof setTimeout> }>({});

  const clearReconnectTimers = () => {
    clearTimeout(reconnectTimersRef.current.toConnected);
    clearTimeout(reconnectTimersRef.current.toIdle);
  };

  const handleOnline = () => {
    setIsOnline(true);
    if (!sawOfflineRef.current) {
      // Never actually offline (e.g. a spurious duplicate "online" event) —
      // nothing to reconnect from, so nothing to announce.
      setConnectionStatus(null);
      return;
    }
    sawOfflineRef.current = false;
    clearReconnectTimers();
    setConnectionStatus("reconnecting");
    reconnectTimersRef.current.toConnected = setTimeout(() => {
      setConnectionStatus("connected");
      reconnectTimersRef.current.toIdle = setTimeout(() => setConnectionStatus(null), CONNECTED_MS);
    }, RECONNECTING_MS);
  };

  const handleOffline = () => {
    sawOfflineRef.current = true;
    clearReconnectTimers();
    setIsOnline(false);
    setConnectionStatus("offline");
  };

  // Refs keep callback values fresh without causing listener re-registration
  const isLockedRef        = useRef(isAppLocked);
  const biometricRef       = useRef(biometricEnabled);
  const locationRef        = useRef(location.pathname);
  const navigateRef        = useRef(navigate);
  const setLockedRef       = useRef(setIsAppLocked);
  const timeoutRef         = useRef(appLockTimeoutMinutes);
  const isCallActiveRef    = useRef(isCallActive);
  const onMinimizeCallRef  = useRef(onMinimizeCall);

  useEffect(() => { isLockedRef.current       = isAppLocked;    }, [isAppLocked]);
  useEffect(() => { biometricRef.current      = biometricEnabled; }, [biometricEnabled]);
  useEffect(() => { locationRef.current       = location.pathname; }, [location.pathname]);
  useEffect(() => { navigateRef.current       = navigate;       }, [navigate]);
  useEffect(() => { setLockedRef.current      = setIsAppLocked; }, [setIsAppLocked]);
  useEffect(() => { timeoutRef.current        = appLockTimeoutMinutes; }, [appLockTimeoutMinutes]);
  useEffect(() => { isCallActiveRef.current   = isCallActive;   }, [isCallActive]);
  useEffect(() => { onMinimizeCallRef.current = onMinimizeCall; }, [onMinimizeCall]);

  // Setup once — no deps that change frequently
  useEffect(() => {
    const listeners: Array<{ remove: () => void }> = [];

    const setup = async () => {
      if (Capacitor.isNativePlatform()) {
        try {
          const { App } = await import("@capacitor/app");

          const backL = await App.addListener("backButton", ({ canGoBack }) => {
            if (isLockedRef.current) return;
            // ACCIDENTAL-EXIT FIX: this used to call App.exitApp()
            // unconditionally once there was nowhere left to navigate back
            // to — with zero awareness that a call could be live. Pressing
            // back (or the OS gesture) while on /chat with an active/
            // connecting call killed the whole app, the call engine room included,
            // with no recovery path; the call just silently died. Minimize
            // instead — same outcome as tapping the dock/minimize button
            // mid-call — and only fall through to the real exit when
            // there's genuinely no call to protect.
            if (isCallActiveRef.current()) {
              onMinimizeCallRef.current();
              if (locationRef.current !== "/chat") navigateRef.current("/chat", { replace: true });
              return;
            }
            if (canGoBack) {
              navigateRef.current(-1);
            } else if (locationRef.current !== "/chat") {
              navigateRef.current("/chat", { replace: true });
            } else {
              App.exitApp();
            }
          });
          listeners.push(backL);

          const stateL = await App.addListener("appStateChange", ({ isActive }) => {
            if (!biometricRef.current) return;
            if (!isActive) {
              markAppBackgrounded();
            } else {
              if (shouldLockOnResume(timeoutRef.current)) setLockedRef.current(true);
              clearAppBackgroundedMark();
            }
          });
          listeners.push(stateL);

          // A ringing /important or /urgent alert (native/android/
          // MessageAlertService.kt) stops the moment the person is back in the
          // app — opening it from the notification, or coming back to it, is
          // the acknowledgement. No-op when nothing is ringing / off Android.
          const alertL = await App.addListener("appStateChange", ({ isActive }) => {
            if (isActive) void stopNativeMessageAlert();
          });
          listeners.push(alertL);
        } catch (e) {
          /* AUDIT FIX #16: setup failure — silent in production */
        }

        try {
          const { Network } = await import("@capacitor/network");
          const status = await Network.getStatus();
          // Cold-start read: reflect the real state with no pill, don't
          // treat "app just opened offline" as a reconnect.
          setIsOnline(status.connected);
          setConnectionStatus(status.connected ? null : "offline");
          sawOfflineRef.current = !status.connected;
          const netL = await Network.addListener("networkStatusChange", (s) => {
            if (s.connected) handleOnline(); else handleOffline();
          });
          listeners.push(netL);
        } catch (e) {
          /* AUDIT FIX #16: listener setup failure — silent in production */
        }
      }

      // Web fallback for network
      window.addEventListener("online",  handleOnline);
      window.addEventListener("offline", handleOffline);
      if (!navigator.onLine) {
        setIsOnline(false);
        setConnectionStatus("offline");
        sawOfflineRef.current = true;
      }

      return () => {
        window.removeEventListener("online",  handleOnline);
        window.removeEventListener("offline", handleOffline);
      };
    };

    let cleanup: (() => void) | undefined;
    setup().then(fn => { cleanup = fn; });

    return () => {
      listeners.forEach(l => l.remove?.());
      cleanup?.();
      clearReconnectTimers();
    };
  }, []); // empty deps — listeners registered once, values read via refs

  return { isOnline, connectionStatus };
};

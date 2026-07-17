/**
 * useAppNative — native platform lifecycle:
 *   - Android hardware back button
 *   - App backgrounded → biometric lock
 *   - Network connectivity (online/offline banner)
 */
import { useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { useNavigate, useLocation } from "react-router-dom";

export const useAppNative = (
  isAppLocked: boolean,
  setIsAppLocked: (v: boolean) => void,
  biometricEnabled: boolean
) => {
  const navigate = useNavigate();
  const location = useLocation();
  const [isOnline, setIsOnline] = useState(true);

  // Refs keep callback values fresh without causing listener re-registration
  const isLockedRef        = useRef(isAppLocked);
  const biometricRef       = useRef(biometricEnabled);
  const locationRef        = useRef(location.pathname);
  const navigateRef        = useRef(navigate);
  const setLockedRef       = useRef(setIsAppLocked);

  useEffect(() => { isLockedRef.current       = isAppLocked;    }, [isAppLocked]);
  useEffect(() => { biometricRef.current      = biometricEnabled; }, [biometricEnabled]);
  useEffect(() => { locationRef.current       = location.pathname; }, [location.pathname]);
  useEffect(() => { navigateRef.current       = navigate;       }, [navigate]);
  useEffect(() => { setLockedRef.current      = setIsAppLocked; }, [setIsAppLocked]);

  // Setup once — no deps that change frequently
  useEffect(() => {
    const listeners: Array<{ remove: () => void }> = [];

    const setup = async () => {
      if (Capacitor.isNativePlatform()) {
        try {
          const { App } = await import("@capacitor/app");

          const backL = await App.addListener("backButton", ({ canGoBack }) => {
            if (isLockedRef.current) return;
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
            if (!isActive && biometricRef.current) {
              setLockedRef.current(true);
            }
          });
          listeners.push(stateL);
        } catch (e) {
          /* AUDIT FIX #16: setup failure — silent in production */
        }

        try {
          const { Network } = await import("@capacitor/network");
          const status = await Network.getStatus();
          setIsOnline(status.connected);
          const netL = await Network.addListener("networkStatusChange", (s) => {
            setIsOnline(s.connected);
          });
          listeners.push(netL);
        } catch (e) {
          /* AUDIT FIX #16: listener setup failure — silent in production */
        }
      }

      // Web fallback for network
      const onOnline  = () => setIsOnline(true);
      const onOffline = () => setIsOnline(false);
      window.addEventListener("online",  onOnline);
      window.addEventListener("offline", onOffline);

      return () => {
        window.removeEventListener("online",  onOnline);
        window.removeEventListener("offline", onOffline);
      };
    };

    let cleanup: (() => void) | undefined;
    setup().then(fn => { cleanup = fn; });

    return () => {
      listeners.forEach(l => l.remove?.());
      cleanup?.();
    };
  }, []); // empty deps — listeners registered once, values read via refs

  return { isOnline };
};

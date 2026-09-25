import { useCallback, useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { DuospaceAudioRoute, type AudioRoute } from "duospace-audio-route";

/**
 * Real OS-level call audio route (earpiece / speaker / Bluetooth / wired
 * headset), backed by the local `duospace-audio-route` Capacitor plugin.
 * No-ops everywhere except a real native build with the plugin synced in
 * (`cap sync` after `cap add android` / `cap add ios`) — on web/dev this
 * just reports unsupported so callers can hide the UI instead of showing a
 * control that can't do anything.
 */
export const useAudioRoute = (active: boolean) => {
  const [supported, setSupported] = useState(false);
  const [routes, setRoutes] = useState<AudioRoute[]>([]);
  const [current, setCurrent] = useState<AudioRoute | null>(null);
  const listenerRef = useRef<{ remove: () => void } | null>(null);

  useEffect(() => {
    setSupported(Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("DuospaceAudioRoute"));
  }, []);

  const refresh = useCallback(async () => {
    if (!supported) return;
    try {
      const [{ routes: r }, { route }] = await Promise.all([
        DuospaceAudioRoute.listRoutes(),
        DuospaceAudioRoute.getCurrentRoute(),
      ]);
      setRoutes(r);
      setCurrent(route);
    } catch {
      // No active call session yet — harmless, next refresh() (e.g. after
      // join) will pick routes up.
    }
  }, [supported]);

  useEffect(() => {
    if (!supported || !active) return;
    refresh();
    DuospaceAudioRoute.addListener("routeChanged", (e) => setCurrent(e.route)).then((h) => {
      listenerRef.current = h;
    });
    return () => {
      listenerRef.current?.remove();
      listenerRef.current = null;
    };
  }, [supported, active, refresh]);

  const setRoute = useCallback(async (route: AudioRoute) => {
    if (!supported) return;
    // Optimistic update — routeChanged listener (or the next refresh) will
    // correct this if the OS ends up choosing something else.
    setCurrent(route);
    try {
      await DuospaceAudioRoute.setRoute({ id: route.id, type: route.type });
    } catch {
      refresh();
    }
  }, [supported, refresh]);

  return { supported, routes, current, refresh, setRoute };
};

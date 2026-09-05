import { useEffect, useRef, useCallback } from "react";
import { Capacitor } from "@capacitor/core";
import { supabase } from "@/integrations/supabase/appClient";
import { logWarn } from "@/lib/telemetry";
import type { DeviceStatus, RingerMode } from "duospace-device-status";

const TELE = "deviceStatus";
const PUBLISH_MIN_INTERVAL_MS = 20_000; // don't hammer the DB on rapid statusChanged bursts

/**
 * Publishes MY battery/ringer status into profiles so my partner can see it
 * (mirrored on their side by the same hook) — surfaced on the Map. Native
 * plugin gives real values on Android (both) and iOS (battery only; ringer
 * is always 'unknown' there — see native-plugins/device-status/README.md,
 * that's a real Apple platform limit, not something this hook can fix).
 *
 * On web/unsupported builds this falls back to the standard Battery Status
 * API where available (best-effort, matches the existing pattern already
 * used in useLiveLocation's debug overlay) and reports ringerMode as
 * 'unknown' — it just doesn't publish anything if neither is available, so
 * the partner's Map simply won't show a status chip rather than showing a
 * stale/fake one.
 */
export function usePublishDeviceStatus(userId: string | null, enabled: boolean) {
  const lastPublishRef = useRef<{ ts: number; level: number | null; charging: boolean | null; ringer: RingerMode } | null>(null);

  const publish = useCallback(async (status: DeviceStatus, force = false) => {
    if (!userId) return;
    const now = Date.now();
    const last = lastPublishRef.current;
    const unchanged = last
      && last.level === status.batteryLevel
      && last.charging === status.charging
      && last.ringer === status.ringerMode;
    if (!force && unchanged && last && now - last.ts < PUBLISH_MIN_INTERVAL_MS) return;
    if (!force && unchanged) return; // nothing actually changed — skip even past the interval
    lastPublishRef.current = { ts: now, level: status.batteryLevel, charging: status.charging, ringer: status.ringerMode };
    try {
      const { error } = await supabase
        .from("profiles")
        .update({
          battery_level: status.batteryLevel,
          battery_charging: status.charging,
          ringer_mode: status.ringerMode,
          device_status_updated_at: new Date(now).toISOString(),
        } as any)
        .eq("user_id", userId);
      if (error) throw error;
    } catch (err) {
      logWarn(TELE, "publish_failed", err);
    }
  }, [userId]);

  useEffect(() => {
    if (!enabled || !userId) return;
    let cancelled = false;
    let removeListener: (() => void) | null = null;

    const nativeAvailable = Capacitor.isPluginAvailable("DuospaceDeviceStatus");

    const startNative = async () => {
      const { DuospaceDeviceStatus } = await import("duospace-device-status");
      const initial = await DuospaceDeviceStatus.getStatus().catch(() => null);
      if (cancelled) return;
      if (initial) void publish(initial, true);
      const handle = await DuospaceDeviceStatus.addListener("statusChanged", (status) => {
        void publish(status);
      });
      removeListener = () => handle.remove();
    };

    const startWebFallback = () => {
      // Best-effort web Battery Status API — unsupported on iOS Safari and
      // increasingly restricted on Android Chrome too, hence "best-effort".
      const nav = navigator as any;
      if (!nav?.getBattery) return;
      let battery: any = null;
      nav.getBattery().then((b: any) => {
        if (cancelled) return;
        battery = b;
        const sync = () => {
          void publish({ batteryLevel: Math.round(b.level * 100), charging: b.charging, ringerMode: "unknown" });
        };
        sync();
        b.addEventListener?.("levelchange", sync);
        b.addEventListener?.("chargingchange", sync);
        removeListener = () => {
          b.removeEventListener?.("levelchange", sync);
          b.removeEventListener?.("chargingchange", sync);
        };
      }).catch(() => { /* unsupported — publish nothing, no fake chip on partner's side */ });
    };

    if (nativeAvailable) void startNative();
    else startWebFallback();

    return () => {
      cancelled = true;
      removeListener?.();
    };
  }, [enabled, userId, publish]);
}

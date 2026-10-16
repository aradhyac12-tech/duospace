import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { Network } from "@capacitor/network";
import { DuospaceAppUpdate } from "duospace-app-update";
import { supabase } from "@/integrations/supabase/appClient";
import { invokeEdgeFunction } from "@/lib/edgeFunction";
import prefs from "@/lib/prefs";
import { logWarn } from "@/lib/telemetry";
import { AppUpdateController, type UpdateDeps } from "./appUpdateController";
import type { ConnectionKind, DownloadResponse, InstalledApp, ReleaseInfo, UpdatePlatform } from "./types";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

function createDefaultDeps(): UpdateDeps {
  return {
    platform: () => {
      const p = Capacitor.getPlatform();
      return p === "android" || p === "ios" ? p : "web";
    },
    async detectSupport() {
      if (!Capacitor.isNativePlatform()) return false;
      if (import.meta.env.VITE_DISABLE_SELF_UPDATE === "true") return false;
      const p = Capacitor.getPlatform();
      if (p === "ios") return true;
      if (p !== "android") return false;
      try {
        // A Play-installed app must be updated by Play (policy), never by itself.
        const { installer } = await DuospaceAppUpdate.getInstallSource();
        return installer !== "com.android.vending";
      } catch (e) {
        logWarn("appUpdate", "install source unavailable; self-update disabled", { err: String(e) });
        return false;
      }
    },
    async getInstalled() {
      try {
        const info = await App.getInfo();
        const versionCode = Number.parseInt(info.build, 10);
        if (!Number.isFinite(versionCode)) return null;
        return { versionName: info.version, versionCode, packageName: info.id || null };
      } catch {
        return null;
      }
    },
    async getConnection(): Promise<ConnectionKind> {
      try {
        const s = await Network.getStatus();
        return s.connected ? s.connectionType : "none";
      } catch {
        return "unknown";
      }
    },
    async fetchLatest(platform: UpdatePlatform, currentCode: number, installed?: InstalledApp) {
      // The generated Supabase types predate this RPC (same reason adminApi.ts
      // uses an untyped .rpc); the boundary is RLS / SECURITY DEFINER, not types.
      const { data, error } = await (supabase as any).rpc("get_latest_app_release", {
        _platform: platform,
        _current_code: currentCode,
        _package_name: installed?.packageName ?? null,
        _current_version: installed?.versionName ?? null,
      });
      return { release: (data ?? null) as ReleaseInfo | null, error: error ? String(error.message ?? error) : null };
    },
    requestDownload: (releaseId: string) =>
      invokeEdgeFunction<DownloadResponse>("app-release-download", { body: { release_id: releaseId } }),
    plugin: DuospaceAppUpdate,
    store: prefs,
    openUrl: (url: string) => {
      window.location.href = url; // itms-services:// or https:// is handed to the OS
    },
    now: () => Date.now(),
  };
}

export const appUpdateController = new AppUpdateController(createDefaultDeps());

let started = false;

/** Idempotent. Checks on launch, on resume (>10 min since last) and every 6 h. */
export function initAppUpdates(): void {
  if (started) return;
  started = true;
  void appUpdateController.init();
  if (!Capacitor.isNativePlatform()) return;
  void App.addListener("appStateChange", ({ isActive }) => {
    if (isActive) void appUpdateController.handleResume();
  });
  setInterval(() => void appUpdateController.check({ silent: true }), SIX_HOURS_MS);
}

export * from "./types";
export { decideNetwork, formatBytes, isNewerThanInstalled, compareSemver } from "./policy";

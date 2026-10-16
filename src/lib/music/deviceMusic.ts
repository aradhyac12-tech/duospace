/**
 * "Scan phone" — JS side of the native DeviceMusic plugin (android/.../DeviceMusicPlugin.kt).
 * Android only. Lists audio already on the phone via MediaStore; nothing is copied.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";
import { syncDeviceTracks, backfillDeviceArt, type DeviceScanItem } from "@/lib/music/localLibrary";

interface DeviceMusicNative {
  checkPermission(): Promise<{ granted: boolean }>;
  requestPermission(): Promise<{ granted: boolean }>;
  scan(opts?: { limit?: number }): Promise<{ tracks: DeviceScanItem[] }>;
  getArt(opts: { id: string; size?: number }): Promise<{ art?: string }>;
}
const DeviceMusic = registerPlugin<DeviceMusicNative>("DeviceMusic");

export const isDeviceScanSupported = (): boolean => Capacitor.getPlatform() === "android";

export type ScanOutcome =
  | { ok: true; found: number; added: number; removed: number }
  | { ok: false; reason: "unsupported" | "denied" | "failed" };

export async function scanDeviceMusic(): Promise<ScanOutcome> {
  if (!isDeviceScanSupported()) return { ok: false, reason: "unsupported" };
  try {
    let granted = (await DeviceMusic.checkPermission()).granted;
    if (!granted) granted = (await DeviceMusic.requestPermission()).granted;
    if (!granted) return { ok: false, reason: "denied" };
    const { tracks } = await DeviceMusic.scan({ limit: 5000 });
    const { added, removed } = syncDeviceTracks(Array.isArray(tracks) ? tracks : []);
    void loadDeviceArt(); // real album art, filled in quietly in the background
    return { ok: true, found: tracks.length, added, removed };
  } catch (e) {
    // "UNIMPLEMENTED" = APK built without the plugin registered; anything else = scan error.
    return { ok: false, reason: String((e as Error)?.message ?? e).includes("permission_denied") ? "denied" : "failed" };
  }
}

const getArt = async (id: string): Promise<string | null> => (await DeviceMusic.getArt({ id, size: 200 })).art ?? null;

/** Background album-art fill for scanned songs. Never prompts; does nothing without permission. */
export async function loadDeviceArt(): Promise<void> {
  if (!isDeviceScanSupported()) return;
  try {
    if (!(await DeviceMusic.checkPermission()).granted) return;
    await backfillDeviceArt(getArt);
  } catch { /* art is cosmetic */ }
}

/**
 * Registers / clears the per-device credential that lets the Android native
 * layer upload a push-triggered location fix while the app is closed
 * (KI-12 gap 2). Server side: supabase/functions/location-push-register and
 * location-push-upload. Native side: PushUploadCredentialStore.kt +
 * DuoSpaceLocationService.uploadFixNatively().
 *
 * Android only. iOS cannot wake a terminated app from an ordinary message push
 * at all (OS constraint — see docs/BACKGROUND_LOCATION_NATIVE.md), so there is
 * nothing to register there. Everything here is best-effort and never throws:
 * a failure just means "foreground/backgrounded-but-alive behaviour, same as
 * before" — it can never break sign-in or the map.
 * UNVERIFIED on a device.
 */
import { Capacitor } from "@capacitor/core";
import { DuospaceBackgroundGeolocation } from "duospace-background-geolocation";
import { invokeEdgeFunction } from "@/lib/edgeFunction";
import { getDeviceId } from "@/lib/deviceId";
import { logInfo, logWarn } from "@/lib/telemetry";

const TELE = "locationPush";

interface RegisterResponse {
  credential_id: string;
  secret: string;
  upload_url: string;
}

function isAndroidNative(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

let inFlight: Promise<void> | null = null;

/**
 * Makes sure this device holds a credential for [userId]. No-ops when one is
 * already stored for that same user. If a DIFFERENT user's credential is stored
 * (account switch on a shared device) it is replaced, so a push can never
 * upload one account's location under another.
 */
export function ensureLocationPushCredential(userId: string): Promise<void> {
  if (!isAndroidNative() || !userId) return Promise.resolve();
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const { userId: storedFor } = await DuospaceBackgroundGeolocation.getPushUploadCredentialUser();
      if (storedFor === userId) return;
      const deviceId = await getDeviceId();
      const res = await invokeEdgeFunction<RegisterResponse>("location-push-register", {
        body: { device_id: deviceId },
      });
      if (!res?.credential_id || !res?.secret || !res?.upload_url) {
        logWarn(TELE, "register_bad_response");
        return;
      }
      await DuospaceBackgroundGeolocation.setPushUploadCredential({
        userId,
        credentialId: res.credential_id,
        secret: res.secret,
        uploadUrl: res.upload_url,
      });
      logInfo(TELE, "credential_registered");
    } catch (err) {
      // Old APK without the native methods, offline, or server error.
      logWarn(TELE, "register_failed", err);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Sign-out: forget the credential on this device so pushes stop uploading. */
export async function clearLocationPushCredential(): Promise<void> {
  if (!isAndroidNative()) return;
  try {
    await DuospaceBackgroundGeolocation.clearPushUploadCredential();
  } catch {
    /* best-effort */
  }
}

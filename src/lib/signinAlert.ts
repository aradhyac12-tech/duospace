import { invokeEdgeFunction } from "@/lib/edgeFunction";
import { computeDeviceFingerprint, collectDeviceInfo } from "@/lib/deviceFingerprint";
import { logWarn } from "@/lib/telemetry";

let inFlight: Promise<void> | null = null;

export function notifyCurrentDeviceSignIn(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const fingerprint = await computeDeviceFingerprint();
      await invokeEdgeFunction("notify-signin", {
        body: {
          fingerprint,
          ...collectDeviceInfo(),
        },
        timeoutMs: 10000,
      });
    } catch (error) {
      logWarn("auth.signin_alert", "new-device email alert skipped", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
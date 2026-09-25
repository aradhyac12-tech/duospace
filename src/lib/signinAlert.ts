import { invokeEdgeFunction } from "@/lib/edgeFunction";
import { computeDeviceFingerprint, collectDeviceInfo } from "@/lib/deviceFingerprint";
import { logWarn } from "@/lib/telemetry";

let inFlight: Promise<void> | null = null;

export function notifyCurrentDeviceSignIn(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const fingerprint = await computeDeviceFingerprint();
      const result = await invokeEdgeFunction<{ known?: boolean; emailed?: boolean; emailError?: string }>(
        "notify-signin",
        {
          body: {
            fingerprint,
            ...collectDeviceInfo(),
          },
          timeoutMs: 10000,
        },
      );
      // Was previously discarded — notify-signin used to always report
      // emailed:true even when the underlying Resend call failed, so there
      // was nothing useful to check here. Now that it reports honestly,
      // surface a real failure into telemetry instead of it vanishing
      // silently (this call is intentionally best-effort otherwise — a
      // failed device-alert email shouldn't interrupt sign-in).
      if (result?.known === false && result.emailed === false) {
        logWarn("auth.signin_alert", "new-device email did not send", {
          error: result.emailError,
        });
      }
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
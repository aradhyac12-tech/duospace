import { useCallback, useEffect, useState } from "react";
import { Capacitor } from "@capacitor/core";

export type LockMethod = "biometric" | "pin" | "none";

export interface BiometricCapabilities {
  available: boolean;
  method: "fingerprint" | "face" | "iris" | "multiple" | "none";
}

/**
 * Full biometric + PIN fallback lock hook.
 * iOS: Face ID / Touch ID via NativeBiometric
 * Android: Fingerprint / Face unlock via NativeBiometric
 * Web: Falls back to PIN entry (shown in AppLockScreen)
 */
export const useBiometricLock = (
  isLocked: boolean,
  setIsLocked: (locked: boolean) => void,
  enabled: boolean
) => {
  const [capabilities, setCapabilities] = useState<BiometricCapabilities>({ available: false, method: "none" });
  const [biometricError, setBiometricError] = useState<string | null>(null);

  // Probe biometric availability on mount
  useEffect(() => {
    const probe = async () => {
      if (!Capacitor.isNativePlatform()) {
        setCapabilities({ available: false, method: "none" });
        return;
      }
      try {
        const { NativeBiometric } = await import("capacitor-native-biometric");
        const result = await NativeBiometric.isAvailable();
        if (result.isAvailable) {
          const biometryType = (result as any).biometryType;
          const method =
            biometryType === 1 ? "fingerprint"
            : biometryType === 2 ? "face"
            : biometryType === 3 ? "iris"
            : biometryType === 4 ? "multiple"
            : "fingerprint";
          setCapabilities({ available: true, method });
        } else {
          setCapabilities({ available: false, method: "none" });
        }
      } catch {
        setCapabilities({ available: false, method: "none" });
      }
    };
    probe();
  }, []);

  const authenticateWithBiometric = useCallback(async (): Promise<boolean> => {
    if (!Capacitor.isNativePlatform()) return false;
    try {
      const { NativeBiometric } = await import("capacitor-native-biometric");
      const name = (() => { try { return localStorage.getItem("duo-app-name") || "DuoSpace"; } catch { return "DuoSpace"; } })();
      await NativeBiometric.verifyIdentity({
        reason: `Unlock ${name}`,
        title: "Authentication Required",
        subtitle: "Verify your identity to continue",
        description: capabilities.method === "face"
          ? "Look at your phone to unlock"
          : "Place your finger on the sensor",
        negativeButtonText: "Use PIN",
        maxAttempts: 3,
      });
      setBiometricError(null);
      return true;
    } catch (err: any) {
      // Code 10 = user pressed "Use PIN" / cancelled to use fallback
      const code = err?.code ?? err?.message ?? "";
      const isCancelled = String(code).includes("10") || String(code).includes("cancel") || String(code).includes("Cancel");
      if (!isCancelled) setBiometricError("Biometric failed — try PIN");
      return false;
    }
  }, [capabilities.method]);

  const authenticate = useCallback(async () => {
    if (!enabled) { setIsLocked(false); return; }

    if (Capacitor.isNativePlatform() && capabilities.available) {
      const ok = await authenticateWithBiometric();
      if (ok) { setIsLocked(false); }
      // If not ok, AppLockScreen shows PIN fallback
    } else {
      // Web/no-biometric: unlock directly (PIN handled in AppLockScreen)
      setIsLocked(false);
    }
  }, [enabled, capabilities.available, authenticateWithBiometric, setIsLocked]);

  // Auto-trigger when locked
  useEffect(() => {
    if (isLocked && enabled && capabilities.available) {
      authenticate();
    }
  }, [isLocked, enabled, capabilities.available, authenticate]);

  return { authenticate, capabilities, biometricError, setBiometricError };
};

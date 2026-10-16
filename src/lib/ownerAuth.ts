/**
 * Re-authentication gate for changing biometric data, like phones do: you
 * can't add, replace or delete a face template without proving who you are
 * first (device biometric). On web / devices without biometric hardware there
 * is nothing stronger to ask for, so it passes.
 */
import { Capacitor } from "@capacitor/core";

export async function requireOwnerAuth(title = "Confirm it's you"): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return true;
  try {
    const { NativeBiometric } = await import("capacitor-native-biometric");
    const probe = await NativeBiometric.isAvailable();
    if (!probe.isAvailable) return true;
    await NativeBiometric.verifyIdentity({
      reason: "Change face data", title, subtitle: "Face data can only be changed by you",
      description: "Verify with your fingerprint or face",
    });
    return true;
  } catch {
    return false;
  }
}

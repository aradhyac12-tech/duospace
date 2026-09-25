/**
 * Stable device fingerprint for Instagram-style new-device sign-in alerts.
 * Hashes a few low-entropy signals; not for security, just to recognise repeat devices.
 */
export async function computeDeviceFingerprint(): Promise<string> {
  const parts = [
    navigator.userAgent || "",
    (navigator as { platform?: string }).platform || "",
    navigator.language || "",
    `${screen.width}x${screen.height}x${screen.colorDepth}`,
    Intl.DateTimeFormat().resolvedOptions().timeZone || "",
  ].join("|");
  const buf = new TextEncoder().encode(parts);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function collectDeviceInfo() {
  return {
    userAgent: navigator.userAgent || "",
    platform: (navigator as { platform?: string }).platform || "",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
  };
}

/**
 * Honest playback-capability wording per provider (pure; shared by the cards' dots/badges).
 * YouTube plays through the embedded IFrame: it is NOT a native background stream, so it can stop when the
 * screen locks. SoundCloud / Audius / Free Music / My Files go through the native engine and CAN keep playing
 * in the background (availability of an individual track is never promised). Wording is deliberately plain.
 */
const NATIVE = new Set(["soundcloud", "audius", "jamendo"]);

export function providerCapabilityNote(provider: string | undefined): string {
  if (!provider) return "";
  if (provider === "youtube") return "plays in the app only and may stop when the screen locks";
  if (provider === "local") return "stored on this device, can keep playing in the background";
  if (NATIVE.has(provider)) return "can keep playing when the screen is locked";
  return "";
}

/** "YouTube — plays in the app only…" for title/aria-label text; the bare label when nothing is known. */
export function providerLabelWithCapability(provider: string | undefined, label: string): string {
  const note = providerCapabilityNote(provider);
  return note ? `${label} — ${note}` : label;
}

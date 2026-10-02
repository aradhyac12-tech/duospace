/**
 * User-facing switches for what this device keeps for offline use
 * (Settings → Data & Backup → "Offline & storage"). Stored in plain local
 * storage (they are preferences, not data) and read synchronously by the
 * chat cache / media cache so a change takes effect immediately.
 *
 * Defaults match the owner's request for WhatsApp-like behaviour: chat history
 * and media kept on-device, downloads allowed on any connection.
 */
import storage from "@/lib/storage";

export interface OfflinePrefs {
  /** Keep the decrypted chat history (encrypted at rest) on this device. */
  chatHistory: boolean;
  /** Keep Shayari, Us and Gallery data (encrypted) on this device so those screens open offline. */
  screenData: boolean;
  /** Keep chat photos / voice notes / small videos on this device. */
  mediaCache: boolean;
  /** Only download media for offline use on Wi-Fi (never on mobile data). */
  wifiOnlyMedia: boolean;
}

const KEYS: Record<keyof OfflinePrefs, string> = {
  chatHistory: "duo-offline-chat-history",
  screenData: "duo-offline-screen-data",
  mediaCache: "duo-offline-media-cache",
  wifiOnlyMedia: "duo-offline-media-wifi-only",
};
const DEFAULTS: OfflinePrefs = { chatHistory: true, screenData: true, mediaCache: true, wifiOnlyMedia: false };

export function getOfflinePref<K extends keyof OfflinePrefs>(key: K): OfflinePrefs[K] {
  const raw = storage.get(KEYS[key]);
  return (raw === null ? DEFAULTS[key] : raw === "1") as OfflinePrefs[K];
}

export function setOfflinePref<K extends keyof OfflinePrefs>(key: K, value: OfflinePrefs[K]): void {
  storage.set(KEYS[key], value ? "1" : "0");
}

export function getOfflinePrefs(): OfflinePrefs {
  return {
    chatHistory: getOfflinePref("chatHistory"),
    screenData: getOfflinePref("screenData"),
    mediaCache: getOfflinePref("mediaCache"),
    wifiOnlyMedia: getOfflinePref("wifiOnlyMedia"),
  };
}

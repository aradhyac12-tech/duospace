/**
 * What this device keeps for offline use — AUTOMATIC, like WhatsApp.
 *
 * Chat history, saved lists and opened photos / voice notes are always kept on
 * the device so the app opens instantly and works with no connection — those
 * three are NOT user-configurable (the old switches were removed on the
 * owner's request and their stored values are ignored).
 *
 * ONE choice is the person's again (v3.22.22, owner chose it, WhatsApp-style):
 * `wifiOnlyMedia` — hold background media downloads back while on mobile data.
 * Default OFF (= the previous behaviour). It only delays saving a copy; opening
 * a photo still streams it online, and nothing already stored is touched.
 * Sign-out / unlink still wipes everything (wipeLocalConversationData).
 */
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

const WIFI_ONLY_KEY = "duo-offline-wifi-only-media";
const AUTOMATIC = { chatHistory: true, screenData: true, mediaCache: true } as const;

function readWifiOnly(): boolean {
  try { return localStorage.getItem(WIFI_ONLY_KEY) === "1"; } catch { return false; }
}

export function getOfflinePref<K extends keyof OfflinePrefs>(key: K): OfflinePrefs[K] {
  if (key === "wifiOnlyMedia") return readWifiOnly() as OfflinePrefs[K];
  return AUTOMATIC[key as keyof typeof AUTOMATIC] as OfflinePrefs[K];
}

/** Only `wifiOnlyMedia` can be changed; every other offline behaviour is automatic (no-op). */
export function setOfflinePref<K extends keyof OfflinePrefs>(key: K, value: OfflinePrefs[K]): void {
  if (key !== "wifiOnlyMedia") return;
  try {
    if (value) localStorage.setItem(WIFI_ONLY_KEY, "1");
    else localStorage.removeItem(WIFI_ONLY_KEY);
  } catch { /* storage unavailable → stays at the default */ }
}

export function getOfflinePrefs(): OfflinePrefs {
  return { ...AUTOMATIC, wifiOnlyMedia: readWifiOnly() };
}

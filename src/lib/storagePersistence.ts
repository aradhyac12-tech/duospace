/**
 * Storage durability + size awareness for the on-device caches
 * (chat history, screen snapshots, media blobs — all IndexedDB).
 *
 * WHAT WAS MISSING: nothing ever asked the browser/WebView to treat this data
 * as persistent, so under storage pressure the OS was free to evict the whole
 * origin ("best-effort" storage) — the offline cache silently vanished. And the
 * media cap was a fixed 400 MB regardless of how much room the device really
 * grants this origin.
 *
 * `navigator.storage.persist()` is a request, not a guarantee: Chrome decides
 * by its own heuristics and many Android WebViews simply answer "no" or do not
 * implement it. It is cheap and harmless, so it is asked once per launch; the
 * answer is only logged. `navigator.storage.estimate()` is used to keep the
 * media cache inside a share of the real quota.
 */
import { logWarn } from "@/lib/telemetry";

/** Never shrink the media cache below this, whatever the quota says. */
export const MIN_MEDIA_CAP_BYTES = 50 * 1024 * 1024;
/** The media cache may use at most this share of the origin's quota. */
export const MEDIA_QUOTA_SHARE = 0.5;

/**
 * Effective media-cache cap: the fixed `hardCap`, lowered to half the origin's
 * quota when the quota is known and smaller, and never below MIN_MEDIA_CAP_BYTES.
 * Pure — unit-tested.
 */
export function computeMediaCap(hardCap: number, quota: number | null | undefined): number {
  if (typeof quota !== "number" || !Number.isFinite(quota) || quota <= 0) return hardCap;
  const share = Math.floor(quota * MEDIA_QUOTA_SHARE);
  return Math.max(MIN_MEDIA_CAP_BYTES, Math.min(hardCap, share));
}

export function isQuotaError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
}

let persistRequest: Promise<boolean | null> | null = null;

/**
 * Ask once per launch for persistent storage. Resolves true (granted / already
 * persistent), false (refused) or null (unsupported / error). Never throws.
 */
export function requestPersistentStorage(): Promise<boolean | null> {
  if (persistRequest) return persistRequest;
  persistRequest = (async () => {
    try {
      const s = typeof navigator !== "undefined" ? navigator.storage : undefined;
      if (!s || typeof s.persist !== "function") return null;
      if (typeof s.persisted === "function" && (await s.persisted())) return true;
      const granted = await s.persist();
      if (!granted) logWarn("storage", "persistent storage not granted — the OS may evict the offline cache under pressure");
      return granted;
    } catch {
      return null;
    }
  })();
  return persistRequest;
}

export interface StorageEstimate { usage: number | null; quota: number | null }

export async function getStorageEstimate(): Promise<StorageEstimate> {
  try {
    const s = typeof navigator !== "undefined" ? navigator.storage : undefined;
    if (!s || typeof s.estimate !== "function") return { usage: null, quota: null };
    const e = await s.estimate();
    return { usage: typeof e.usage === "number" ? e.usage : null, quota: typeof e.quota === "number" ? e.quota : null };
  } catch {
    return { usage: null, quota: null };
  }
}

/** Test hook. */
export function _resetStoragePersistenceForTests(): void {
  persistRequest = null;
}

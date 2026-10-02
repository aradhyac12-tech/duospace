/**
 * Connectivity — one place that answers "are we online right now?" for code
 * that is NOT a React component (fetch wrappers, stores, send queues).
 *
 * WHY THIS EXISTS (offline-first pass, 2026-09-21):
 *   The app used to discover it was offline the slow way — by issuing a
 *   request and waiting for it to fail (or, on a "Wi-Fi with no internet"
 *   network, to time out). Every launch-time fetch therefore stalled, and
 *   every failed send looked like a real error. Local-first code needs a
 *   cheap synchronous answer instead.
 *
 * HONEST LIMITS:
 *   - `navigator.onLine === false` is reliable ("definitely offline").
 *     `navigator.onLine === true` is NOT proof of internet (captive portals,
 *     Wi-Fi with a dead uplink). So `isOnlineNow()` is used only to
 *     SHORT-CIRCUIT work when we are definitely offline; it is never used to
 *     assume a request will succeed. Real failures are still classified with
 *     `isNetworkError()` below.
 *   - @capacitor/network is deliberately NOT allowed to veto requests. Its
 *     "connected" flag can read false on networks that actually carry traffic
 *     (unvalidated captive-portal checks, VPN/private-DNS setups); if that
 *     ever blocked fetches the whole app would be stranded offline with no way
 *     out. It is used only the other way round — to announce "back online"
 *     (synthetic window event) on WebViews whose own `online` event lags.
 */

let started = false;

const listeners = new Set<(online: boolean) => void>();

function webOnline(): boolean {
  try {
    return typeof navigator === "undefined" ? true : navigator.onLine !== false;
  } catch {
    return true;
  }
}

/** True unless we are DEFINITELY offline. Synchronous and cheap. */
export function isOnlineNow(): boolean {
  return webOnline();
}

function emit() {
  const now = isOnlineNow();
  listeners.forEach((cb) => {
    try { cb(now); } catch { /* a bad listener must not break the others */ }
  });
}

/** Subscribe to online/offline transitions. Returns an unsubscribe function. */
export function subscribeConnectivity(cb: (online: boolean) => void): () => void {
  startConnectivityMonitor();
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Start listening (idempotent). Safe to call from anywhere. */
export function startConnectivityMonitor(): void {
  if (started || typeof window === "undefined") return;
  started = true;

  window.addEventListener("online", emit);
  window.addEventListener("offline", emit);

  // Native: announce "back online" on WebViews whose own `online` event lags.
  // Never used to veto requests (see header).
  void (async () => {
    try {
      const { Capacitor } = await import("@capacitor/core");
      if (!Capacitor.isNativePlatform()) return;
      const { Network } = await import("@capacitor/network");
      let last: boolean | null = null;
      await Network.addListener("networkStatusChange", (s) => {
        const reconnected = s.connected && last === false;
        last = s.connected;
        if (reconnected) {
          try { window.dispatchEvent(new Event("online")); } catch { /* ignore */ }
        }
      });
      last = (await Network.getStatus()).connected;
    } catch {
      /* plugin unavailable — web events alone still work */
    }
  })();
}

/**
 * Does this thrown value look like "the network is down / unreachable" (as
 * opposed to "the server rejected the request")? Used to decide between
 * "queue it and retry when we're back" and "show a real error".
 */
export function isNetworkError(err: unknown): boolean {
  if (!isOnlineNow()) return true;
  if (!err) return false;

  // NOTE: fetch() rejects with a TypeError on connectivity failure, but a
  // TypeError is also what a plain programming bug looks like ("cannot read
  // properties of undefined"). Classifying every TypeError as "network"
  // would silently queue real bugs instead of surfacing them, so this goes
  // by the message text below instead (WebKit says "Load failed", Chromium
  // "Failed to fetch", React Native-style shims "Network request failed").
  const name = typeof err === "object" ? String((err as { name?: unknown }).name ?? "") : "";
  if (name === "AbortError" || name === "TimeoutError") return true;
  // supabase-js wraps transport failures in these.
  if (name === "AuthRetryableFetchError") return true;

  const raw =
    typeof err === "string"
      ? err
      : typeof err === "object"
        ? String((err as { message?: unknown }).message ?? "")
        : "";
  const msg = raw.toLowerCase();
  return (
    msg.includes("failed to fetch") ||
    msg.includes("load failed") ||
    msg.includes("network request failed") ||
    msg.includes("networkerror") ||
    msg.includes("network error") ||
    msg.includes("fetch failed") ||
    msg.includes("timed out") ||
    msg.includes("timeout") ||
    msg.includes("err_internet_disconnected") ||
    msg.includes("err_network_changed")
  );
}

/** Test seam — resets module state. Not used in app code. */
export function __resetConnectivityForTests(): void {
  started = false;
  listeners.clear();
}

// Stale-chunk recovery.
//
// Every deploy gives each lazy chunk a new content hash (Calls-XXXX.js,
// Chat-XXXX.js, ...) and the old files disappear. A tab / installed PWA that
// still runs the previous index-*.js then asks for a chunk that no longer
// exists and the dynamic import() rejects with "Failed to fetch dynamically
// imported module". Reloading fetches the fresh index.html + hashes.
// The reload is rate-limited so a genuinely broken deploy can't loop.

const RELOAD_KEY = "ds:chunk-reload-at";
const RELOAD_COOLDOWN_MS = 60_000;

export function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err ?? "");
  return /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|loading chunk [\w-]+ failed|chunkloaderror/i.test(
    msg,
  );
}

/** Reload the page once per cooldown window. Returns true if a reload was started. */
export function reloadOnceForStaleChunk(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
    if (Date.now() - last < RELOAD_COOLDOWN_MS) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return false; // no storage -> can't guard against a loop, so don't reload
  }
  window.location.reload();
  return true;
}

/**
 * Wrap a dynamic-import factory: retry once (transient network), then reload
 * once to pick up the new deploy. If the reload is refused (already tried
 * recently) the original error propagates to the ErrorBoundary.
 */
export function withChunkRetry<T>(factory: () => Promise<T>): () => Promise<T> {
  return async () => {
    try {
      return await factory();
    } catch (first) {
      if (!isChunkLoadError(first)) throw first;
      try {
        await new Promise((r) => setTimeout(r, 400));
        return await factory();
      } catch (second) {
        if (isChunkLoadError(second) && reloadOnceForStaleChunk()) {
          return new Promise<T>(() => {}); // page is reloading; never resolve
        }
        throw second;
      }
    }
  };
}

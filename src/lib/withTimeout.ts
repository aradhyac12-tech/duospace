// Generic "race a promise against a timer" helper. Several call sites
// already hand-rolled this pattern locally (capacitorAuthStorage.ts,
// prefs.ts) for native-plugin calls; this is the same idea shared, for use
// anywhere a promise has no built-in timeout of its own — most importantly
// raw `supabase.rpc()`/`supabase.from()` calls, which (unlike
// invokeEdgeFunction, see src/lib/edgeFunction.ts) have no timeout at all.
// A stalled fetch on a flaky connection can leave those pending forever —
// neither resolving nor rejecting — which is fatal for any caller that
// `await`s them before doing anything else, since nothing runs after an
// await that never settles.

export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Races `promise` against a timer. If the timer wins, rejects with
 * TimeoutError instead of waiting any longer. JS has no true promise
 * cancellation, so the original `promise` is NOT aborted — it may still
 * settle in the background and its result is simply ignored — but the
 * caller stops waiting on it.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label = "Operation"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

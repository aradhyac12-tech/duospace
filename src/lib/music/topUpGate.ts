/**
 * One shared auto-next top-up per (current-track) generation — pure, testable.
 *
 * Why: the old guard shared ONE in-flight promise no matter which track it was started for, so after a
 * skip a caller got the previous track's lookup, and its late result was appended to the queue even though
 * the person had moved on. Here the in-flight lookup is keyed (callers for the same key join it; a
 * different key starts its own), and the result is only applied if `isFresh()` is still true when it lands.
 */
export function createTopUpGate<T>() {
  let flight: { key: string; p: Promise<T[]> } | null = null;
  return {
    run(key: string, load: () => Promise<T[]>, isFresh: () => boolean, apply: (items: T[]) => void): Promise<T[]> {
      if (flight && flight.key === key) return flight.p;
      const entry = { key, p: null as unknown as Promise<T[]> };
      flight = entry; // registered BEFORE the body runs: a load() that throws synchronously must still free the slot below
      entry.p = (async () => {
        try {
          const items = await load();
          if (!isFresh()) return [];          // the track/queue moved on: discard, never append
          apply(items);
          return items;
        } catch {
          return [];
        } finally {
          if (flight === entry) flight = null;
        }
      })();
      return entry.p;
    },
    inFlightKey: (): string | null => flight?.key ?? null,
  };
}

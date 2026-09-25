/**
 * Call-history cache — stale-while-revalidate for the Calls tab.
 *
 * On every cold launch the Calls tab used to start from an empty array and
 * flash "No calls yet" until the network round trips (profile -> partner ->
 * call_history) finished. This keeps the last successfully-fetched list on
 * the device so the tab can paint it immediately, while the normal fetch
 * still runs and replaces it with the server's answer.
 *
 * WHY THIS IS SAFE TO PERSIST (and chat messages are NOT):
 *   - It's call METADATA only (direction, type, status, timestamps,
 *     duration). No message content, no keys, no media.
 *   - `room_name` (the provider room identifier) is deliberately dropped —
 *     a cached row is display-only and never used to join anything.
 *   - It goes through secureStorage (AES-256-GCM at rest, scoped per user)
 *     rather than plain localStorage, and is removed by `secureWipeAll()`
 *     on sign-out like every other secureStorage value.
 *   - Chat.tsx's decrypted-message cache is intentionally memory-only (it's
 *     E2E plaintext) and is NOT touched by this file.
 */
import { secureGet, secureSet } from "@/lib/privacy/secureStorage";
import type { CallRecord } from "@/pages/Calls";

const CACHE_KEY = "call-history-cache-v1";
const MAX_CACHED = 50;

/** Strip everything that isn't needed to render a history row. */
function toCacheable(rows: CallRecord[]): CallRecord[] {
  return rows.slice(0, MAX_CACHED).map((r) => ({ ...r, room_name: null }));
}

export async function readCachedCallHistory(userId: string): Promise<CallRecord[] | null> {
  const cached = await secureGet<CallRecord[]>(userId, CACHE_KEY);
  return Array.isArray(cached) ? cached : null;
}

export async function writeCachedCallHistory(userId: string, rows: CallRecord[]): Promise<void> {
  try {
    await secureSet(userId, CACHE_KEY, toCacheable(rows));
  } catch {
    /* best-effort — a failed cache write must never affect the Calls tab */
  }
}

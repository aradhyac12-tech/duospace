/**
 * ACCIDENTAL-CLOSE RECOVERY FIX: previously nothing persisted "there is a
 * live call right now" anywhere outside in-memory React state. Backing out
 * of the app (App.exitApp() bug — see useAppNative.ts, now fixed) or the OS
 * killing the process (low memory, swipe-away from recents) lost the call
 * with literally nothing to recover from on relaunch — the call_history row
 * was left dangling at 'in_progress' (until, at best, a sweep caught it
 * much later) and the person had no way to know whether the other side was
 * still waiting on the line.
 *
 * This is a plain localStorage marker (same pattern as partnerCache.ts /
 * appLockTimer.ts elsewhere in this codebase) written at the moment a call
 * becomes real (OUTGOING_SESSION_CREATED / CONNECTED) and cleared at every
 * ending path — see the reportCallEndedNative call sites in Calls.tsx/
 * Chat.tsx/CallContext.tsx, which now also call clearActiveCallSession()
 * right alongside. On next launch, CallContext checks for a leftover marker
 * and — only if the call_history row genuinely still looks live server-side,
 * never on the strength of the local marker alone — offers to rejoin.
 */

const STORAGE_KEY = "duospace_active_call_session";
// A marker older than this is almost certainly a genuinely abandoned call
// (the other side gave up, the room expired) rather than one still worth
// offering to rejoin — bounds how long a crashed/killed session can prompt
// recovery for, rather than resurfacing an ancient dangling call forever.
const MAX_RECOVERABLE_AGE_MS = 30 * 60 * 1000; // 30 minutes

export interface ActiveCallSession {
  callId: string;
  roomUrl: string;
  callType: "video" | "voice";
  direction: "outgoing" | "incoming";
  partnerName: string;
  /** epoch ms, set at persist time */
  ts: number;
}

export function persistActiveCallSession(session: Omit<ActiveCallSession, "ts">): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...session, ts: Date.now() }));
  } catch {
    /* best-effort — losing the recovery marker just means no recovery
       prompt next launch, never breaks the call itself */
  }
}

export function clearActiveCallSession(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* best-effort */
  }
}

/** Returns the persisted marker if present and not stale — does NOT verify
 *  against the server; callers (CallContext's recovery check) still need to
 *  confirm the call_history row is genuinely still live before offering to
 *  rejoin. A stale-but-present marker is cleared here rather than left to
 *  linger. */
export function readActiveCallSession(): ActiveCallSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ActiveCallSession;
    if (!parsed?.callId || !parsed?.roomUrl || typeof parsed.ts !== "number") {
      clearActiveCallSession();
      return null;
    }
    if (Date.now() - parsed.ts > MAX_RECOVERABLE_AGE_MS) {
      clearActiveCallSession();
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

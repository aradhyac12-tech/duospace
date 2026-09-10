/**
 * appLockTimer — shared "lock after N minutes" threshold logic for App Lock.
 *
 * Previously App Lock re-locked the instant the app was backgrounded, with
 * no configurable grace period (WhatsApp/Signal-style "Lock immediately" vs
 * "Lock after 1/5/15/30 minutes"). Two independent listeners already react
 * to backgrounding — ThemeContext's `visibilitychange` handler (web +
 * native webview) and useAppNative's Capacitor `appStateChange` handler
 * (native-only, needed for the back-button logic in that same hook) — so
 * this lives in one shared module both call into, instead of duplicating
 * (and risking drifting) the same timestamp math twice.
 *
 * Approach: rather than running a background timer (unreliable — mobile
 * OSes routinely suspend backgrounded web views/JS entirely, so a
 * `setTimeout` armed at background-time may never fire), we just record
 * *when* the app went to background in localStorage, then compare against
 * "now" the moment it comes back to the foreground. localStorage also
 * means this survives the OS fully killing the app while backgrounded,
 * not just a simple tab-hide — reopening a killed app 20 minutes later
 * still enforces a 15-minute threshold correctly.
 */
import storage from "@/lib/storage";

const BG_AT_KEY = "duo-app-lock-bg-at";

/** Call the moment the app/tab is hidden (visibilitychange → hidden,
 *  or Capacitor appStateChange → isActive:false). */
export const markAppBackgrounded = (): void => {
  storage.set(BG_AT_KEY, String(Date.now()));
};

/** Call the moment the app/tab becomes visible again. Clears the mark so a
 *  stale timestamp can't leak into some later, unrelated background/resume
 *  cycle. */
export const clearAppBackgroundedMark = (): void => {
  storage.remove(BG_AT_KEY);
};

/** Whether a background-mark from a previous session is still sitting in
 *  storage — used for the cold-start check (app was killed while
 *  backgrounded, so there's no visibilitychange "resume" event to react to
 *  on the fresh mount that follows). */
export const hasBackgroundedMark = (): boolean => storage.get(BG_AT_KEY) != null;

/**
 * Whether resuming now should trigger a lock, given the configured
 * threshold in minutes (0 = "Lock immediately", matching the old
 * always-instant behavior).
 *
 * Fails safe: an unreadable/corrupt timestamp, or no timestamp at all when
 * one was expected (e.g. localStorage was cleared mid-background), returns
 * true — a spurious lock is a minor annoyance, a missed one is a privacy
 * gap.
 */
export const shouldLockOnResume = (timeoutMinutes: number): boolean => {
  if (!timeoutMinutes || timeoutMinutes <= 0) return true;
  const raw = storage.get(BG_AT_KEY);
  if (!raw) return true;
  const bgAt = Number(raw);
  if (!Number.isFinite(bgAt)) return true;
  return Date.now() - bgAt >= timeoutMinutes * 60_000;
};

/** Options shown in Settings — value is minutes, 0 means "Immediately". */
export const APP_LOCK_TIMEOUT_OPTIONS: { value: number; label: string }[] = [
  { value: 0,  label: "Immediately" },
  { value: 1,  label: "After 1 minute" },
  { value: 5,  label: "After 5 minutes" },
  { value: 15, label: "After 15 minutes" },
  { value: 30, label: "After 30 minutes" },
];

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
  // The app only "left" because the user opened the system file/photo/video
  // picker or camera from inside DuoSpace — not a real background. Locking
  // here interrupted the send, and the lock round-trip could lose the
  // selected file and in-chat state (e.g. Vanish Mode).
  if (isExternalPickerActive()) return false;
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


// ─── File/photo/video picker grace ─────────────────────────────────────────
const PICKER_KEY = "duo-app-lock-picker-at";
/** Generous window: picking a long video or browsing a big gallery can take
 *  a while, but a stale mark must never disable locking indefinitely. */
const PICKER_GRACE_MS = 10 * 60_000;

/** Call right before opening a system picker (file input, Camera plugin,
 *  document picker). Installed automatically for every <input type=file>
 *  by installPickerLockGuard(). */
export const markExternalPickerOpen = (): void => {
  storage.set(PICKER_KEY, String(Date.now()));
};

export const clearExternalPickerMark = (): void => { storage.remove(PICKER_KEY); };

export const isExternalPickerActive = (): boolean => {
  const raw = storage.get(PICKER_KEY);
  if (!raw) return false;
  const at = Number(raw);
  if (!Number.isFinite(at) || Date.now() - at > PICKER_GRACE_MS) { storage.remove(PICKER_KEY); return false; }
  return true;
};

let pickerGuardInstalled = false;
/** Marks every file-input click app-wide, and clears the mark shortly after
 *  the app is visible again (delayed so every resume handler — both the
 *  visibilitychange one and Capacitor's appStateChange — sees it first). */
export const installPickerLockGuard = (): void => {
  if (pickerGuardInstalled || typeof document === "undefined") return;
  pickerGuardInstalled = true;
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    if (t instanceof HTMLInputElement && t.type === "file") markExternalPickerOpen();
  }, true);
  // Programmatic inputRef.current.click() calls dispatch a click event too,
  // so the listener above covers those. Clear once we're back:
  const clearSoon = () => { if (!document.hidden) setTimeout(clearExternalPickerMark, 3000); };
  document.addEventListener("visibilitychange", clearSoon);
  window.addEventListener("focus", clearSoon);
  document.addEventListener("change", (e) => {
    if (e.target instanceof HTMLInputElement && e.target.type === "file") setTimeout(clearExternalPickerMark, 3000);
  }, true);
  document.addEventListener("cancel", (e) => {
    if (e.target instanceof HTMLInputElement && e.target.type === "file") setTimeout(clearExternalPickerMark, 3000);
  }, true);
};

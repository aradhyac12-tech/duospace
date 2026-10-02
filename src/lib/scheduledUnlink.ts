/**
 * Scheduled (delayed, unilateral) unlink + "Stop sharing" — shared pieces.
 *
 * Two independent, UNILATERAL tools alongside the consent-based unlink in
 * partnerUnlink.ts (which stays as is):
 *
 *   - Stop sharing: immediate. Stops MY location / device status / shared
 *     reflections reaching my partner while we stay linked. (stop_sharing RPC,
 *     migration 20261002110000_stop_sharing.sql.)
 *   - Scheduled unlink: either person asks to be unlinked; it takes effect
 *     SCHEDULED_UNLINK_DAYS later with nobody's approval. The other person is
 *     told and can see the date; only the person who scheduled it can cancel.
 *     (schedule_unlink RPC, migration 20261002120000_scheduled_unilateral_unlink.sql.)
 *
 * The 14-day delay is fixed in the DATABASE (execute_at is server-set); the
 * constant below is only for wording. Never compute the date client-side.
 */

export const SCHEDULED_UNLINK_DAYS = 14;

/** Window event: "sharing state or a scheduled unlink may have changed, re-check". */
export const SHARING_STATE_CHANGED_EVENT = "duo:sharing-state-changed";

const HANDLED_KEY = "duo-handled-scheduled-unlinks";

export type ScheduledUnlinkStatus = "scheduled" | "cancelled" | "executed" | "void";

export interface ScheduledUnlink {
  id: string;
  requester_id: string;
  partner_id: string;
  status: ScheduledUnlinkStatus;
  created_at: string;
  execute_at: string;
  resolved_at: string | null;
}

/** What the RPCs hand back: a status on success, or `{ error }` (never thrown). */
export interface ScheduledUnlinkRpcResult {
  status?: "scheduled" | "cancelled" | "executed" | "stopped" | "sharing";
  id?: string;
  execute_at?: string;
  reason?: string;
  unlinked?: boolean;
  stopped_at?: string;
  error?: string;
}

/** True while the schedule is live: status 'scheduled' (a due one is completed by the server on its next sweep). */
export function isLiveSchedule(r: Pick<ScheduledUnlink, "status">): boolean {
  return r.status === "scheduled";
}

/** Has the countdown reached its end (so the server will complete it on the next sweep / app open)? */
export function isDue(r: Pick<ScheduledUnlink, "execute_at">, now = Date.now()): boolean {
  const t = Date.parse(r.execute_at);
  return Number.isFinite(t) && t <= now;
}

/** Whole days left, rounded UP so "1 day" shows until it's actually due. 0 once due. */
export function daysUntil(executeAt: string, now = Date.now()): number {
  const t = Date.parse(executeAt);
  if (!Number.isFinite(t) || t <= now) return 0;
  return Math.ceil((t - now) / 86_400_000);
}

export function describeCountdown(executeAt: string, now = Date.now()): string {
  const d = daysUntil(executeAt, now);
  if (d === 0) return "any moment now";
  return d === 1 ? "in 1 day" : `in ${d} days`;
}

export function formatExecuteDate(executeAt: string): string {
  const t = Date.parse(executeAt);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function describeScheduleError(code: string | undefined): string {
  switch (code) {
    case "NOT_LINKED":
      return "You're not linked with anyone anymore.";
    case "ALREADY_HANDLED":
    case "NOT_FOUND":
      return "That schedule has already finished or was cancelled.";
    case "NOT_SIGNED_IN":
      return "Please sign in again and retry.";
    default:
      return "Something went wrong on our end — please try again in a moment.";
  }
}

/** Executed schedules this device has already wrapped up (cache clear + reload), so it happens once. */
export function hasHandledExecuted(id: string): boolean {
  try {
    const raw = localStorage.getItem(HANDLED_KEY);
    return !!raw && (JSON.parse(raw) as string[]).includes(id);
  } catch {
    return false;
  }
}

export function markHandledExecuted(id: string): void {
  try {
    const raw = localStorage.getItem(HANDLED_KEY);
    const list: string[] = raw ? JSON.parse(raw) : [];
    if (!list.includes(id)) list.push(id);
    localStorage.setItem(HANDLED_KEY, JSON.stringify(list.slice(-20)));
  } catch { /* storage unavailable — worst case the wrap-up runs twice, harmlessly */ }
}

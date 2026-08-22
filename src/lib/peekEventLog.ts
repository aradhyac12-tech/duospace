/**
 * peekEventLog — local (never-synced) history of peek-guard lock events.
 *
 * Backs the Security Dashboard: "locks today/this week", "average lock
 * speed", "false-positive rate", "last detection". Everything here is
 * derived from real logged events — there is no synthetic/placeholder
 * data. A stat that doesn't have enough samples yet says so explicitly
 * (getStats() below) rather than showing a misleadingly precise number.
 *
 * Storage: localStorage via lib/storage.ts, capped to the most recent
 * MAX_EVENTS entries (oldest dropped first). Never uploaded — this is a
 * device-local diagnostic log, same privacy posture as the owner
 * embeddings in faceRecognition.ts.
 */
import storage from "@/lib/storage";
import type { PeekDetectionState } from "@/hooks/usePeekDetection";

const KEY = "peek-event-log";
const MAX_EVENTS = 200;

export interface PeekEvent {
  id: string;
  /** ms since epoch when the lock actually fired. */
  ts: number;
  reason: NonNullable<PeekDetectionState["reason"]>;
  threatScore: number;
  /** ms from when the breach was first confirmed (consistency frames
   *  passed) to when the lock actually fired — i.e. just the lockDelay
   *  leg, not detection latency. null if not measured for some reason. */
  timeToLockMs: number | null;
  /** Set later via setEventFeedback() if the person rates it. */
  feedback: "accurate" | "false_alarm" | null;
}

const readAll = (): PeekEvent[] => storage.getJSON<PeekEvent[]>(KEY, []);

export const logPeekEvent = (input: {
  reason: NonNullable<PeekDetectionState["reason"]>;
  threatScore: number;
  timeToLockMs: number | null;
}): string => {
  const events = readAll();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  events.push({ id, ts: Date.now(), feedback: null, ...input });
  while (events.length > MAX_EVENTS) events.shift();
  storage.setJSON(KEY, events);
  return id;
};

export const setEventFeedback = (id: string, feedback: "accurate" | "false_alarm"): void => {
  const events = readAll();
  const ev = events.find((e) => e.id === id);
  if (!ev) return;
  ev.feedback = feedback;
  storage.setJSON(KEY, events);
};

export const getRecentEvents = (limit = 20): PeekEvent[] =>
  readAll().slice(-limit).reverse();

export interface PeekStats {
  locksToday: number;
  locksThisWeek: number;
  lastEvent: PeekEvent | null;
  /** null when there isn't at least MIN_SAMPLES timed events yet. */
  avgLockSpeedMs: number | null;
  /** null when there isn't at least MIN_SAMPLES rated events yet. */
  falsePositiveRate: number | null;
  ratedCount: number;
}

const MIN_SAMPLES_FOR_STAT = 3;

export const getStats = (): PeekStats => {
  const events = readAll();
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

  const locksToday = events.filter((e) => e.ts >= dayAgo).length;
  const locksThisWeek = events.filter((e) => e.ts >= weekAgo).length;
  const lastEvent = events.length ? events[events.length - 1] : null;

  const timed = events.filter((e) => e.timeToLockMs != null) as (PeekEvent & { timeToLockMs: number })[];
  const avgLockSpeedMs = timed.length >= MIN_SAMPLES_FOR_STAT
    ? Math.round(timed.reduce((a, e) => a + e.timeToLockMs, 0) / timed.length)
    : null;

  const rated = events.filter((e) => e.feedback != null);
  const falsePositiveRate = rated.length >= MIN_SAMPLES_FOR_STAT
    ? rated.filter((e) => e.feedback === "false_alarm").length / rated.length
    : null;

  return {
    locksToday, locksThisWeek, lastEvent, avgLockSpeedMs,
    falsePositiveRate, ratedCount: rated.length,
  };
};

export const clearEventLog = (): void => storage.setJSON(KEY, []);

/**
 * BUG FIX ("peek guard shows false alarm and its feedback system doesn't
 * work"): rating a lock "False alarm" in PeekGuard only ever wrote to this
 * log for the Security Dashboard's read-only stats — it had zero effect on
 * anything the detector actually did. Tapping the button "worked" in the
 * sense that it recorded, but nothing about the experience ever changed in
 * response, which reads as "doesn't work." usePeekDetection now calls this
 * periodically and loosens its live match threshold when it does, so
 * repeated false-alarm feedback measurably reduces future false locks
 * instead of only feeding a dashboard nobody but the very curious opens.
 *
 * Deliberately conservative: only kicks in once there's a real signal
 * (MIN_SAMPLES_FOR_STAT rated events), only ever loosens (never tightens
 * above what the person configured), and caps out at a small nudge so a
 * genuinely misconfigured threshold still needs a real settings change.
 */
const FALSE_ALARM_RATE_FLOOR = 0.3;
const MAX_THRESHOLD_RELIEF = 0.06;

export const getFalseAlarmThresholdRelief = (): number => {
  const { falsePositiveRate, ratedCount } = getStats();
  if (falsePositiveRate == null || ratedCount < MIN_SAMPLES_FOR_STAT) return 0;
  if (falsePositiveRate <= FALSE_ALARM_RATE_FLOOR) return 0;
  const over = falsePositiveRate - FALSE_ALARM_RATE_FLOOR; // 0..0.7
  return Math.min(MAX_THRESHOLD_RELIEF, over * (MAX_THRESHOLD_RELIEF / 0.7));
};

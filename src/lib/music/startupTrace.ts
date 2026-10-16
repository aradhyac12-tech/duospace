/**
 * Tap-to-audio startup trace.
 *
 * Splits "I tapped a song" into separately measurable stages so latency claims
 * can be backed by numbers instead of guesses:
 *
 *   tap ──ui──▶ uiCommitted ──resolve──▶ resolved ──load──▶ loadReturned ──native──▶ audible
 *
 *  - ui:      tap -> optimistic setCurrent/setIsPlaying issued (JS-side, no network)
 *  - resolve: stream URL lookup (source = offline | cache | network | none)
 *  - load:    nativeEngine.load() promise (bridge + ExoPlayer prepare call)
 *  - native:  load returned -> first native "playing" event (buffering / first frame)
 *
 * Pure module: no React, no Capacitor, no storage. Timestamps come from an
 * injectable clock so the unit tests are deterministic. It never throws and
 * never blocks playback; the context calls it fire-and-forget.
 */

export type ResolveSource = "offline" | "cache" | "network" | "none";
export type StartupOutcome = "audible" | "superseded" | "failed";

export interface StartupReport {
  trackId: string;
  provider: string;
  outcome: StartupOutcome;
  resolveSource: ResolveSource | null;
  /** Stage durations in ms; a stage that never happened is null. */
  uiMs: number | null;
  resolveMs: number | null;
  loadMs: number | null;
  nativeMs: number | null;
  /** tap -> audible (null unless outcome === "audible"). */
  totalMs: number | null;
}

type Stage = "uiCommitted" | "resolveStart" | "resolved" | "loadStart" | "loadReturned";

interface Active {
  trackId: string;
  provider: string;
  tap: number;
  marks: Partial<Record<Stage, number>>;
  resolveSource: ResolveSource | null;
}

const MAX_KEPT = 50;

export function createStartupTracer(now: () => number = () => performance.now()) {
  let active: Active | null = null;
  const reports: StartupReport[] = [];
  const listeners = new Set<(r: StartupReport) => void>();

  const diff = (a: number | undefined, b: number | undefined) =>
    a === undefined || b === undefined ? null : Math.max(0, Math.round(b - a));

  function finish(outcome: StartupOutcome, audibleAt?: number) {
    if (!active) return;
    const a = active;
    active = null;
    const m = a.marks;
    const report: StartupReport = {
      trackId: a.trackId,
      provider: a.provider,
      outcome,
      resolveSource: a.resolveSource,
      uiMs: diff(a.tap, m.uiCommitted),
      resolveMs: diff(m.resolveStart, m.resolved),
      loadMs: diff(m.loadStart, m.loadReturned),
      nativeMs: diff(m.loadReturned, audibleAt),
      totalMs: outcome === "audible" ? diff(a.tap, audibleAt) : null,
    };
    reports.push(report);
    if (reports.length > MAX_KEPT) reports.shift();
    listeners.forEach((l) => { try { l(report); } catch { /* listener bugs must not affect playback */ } });
  }

  return {
    /** A new tap supersedes any still-pending trace (the old one is reported as "superseded"). */
    begin(trackId: string, provider: string) {
      if (active) finish("superseded");
      active = { trackId, provider, tap: now(), marks: {}, resolveSource: null };
    },
    mark(stage: Stage, trackId: string) {
      if (active && active.trackId === trackId) active.marks[stage] = now();
    },
    setResolveSource(trackId: string, source: ResolveSource) {
      if (active && active.trackId === trackId) active.resolveSource = source;
    },
    /** Native engine reported "playing" for the traced track. */
    audible(trackId: string) {
      if (active && active.trackId === trackId) finish("audible", now());
    },
    fail(trackId: string) {
      if (active && active.trackId === trackId) finish("failed");
    },
    isTracing: (trackId: string) => !!active && active.trackId === trackId,
    reports: () => reports.slice(),
    subscribe(l: (r: StartupReport) => void) { listeners.add(l); return () => { listeners.delete(l); }; },
    reset() { active = null; reports.length = 0; },
  };
}

/** Process-wide tracer used by GroicContext. */
export const startupTracer = createStartupTracer();

/** Median of a numeric list (null for empty) — for summarising a batch of reports. */
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

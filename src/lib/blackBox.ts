/**
 * Black box (flight recorder) — answers "what happened / why did it lag or crash?" AFTER the fact.
 *
 * A WebView that freezes or is killed cannot report on itself, so this keeps a small rolling record on
 * disk while the app runs and reads it on the NEXT launch:
 *  - breadcrumbs: every telemetry log line, route changes, music/call events, global errors, lag spikes;
 *  - lag detector: a 1s heartbeat; if the timer fires >1.5s late the main thread was blocked (logged with the
 *    last breadcrumbs so you can see WHAT was running); >6s is recorded as a freeze;
 *  - long-task observer (>250ms) and JS heap size when the engine exposes it;
 *  - session state: foreground / background / clean. A session found "foreground" at next launch means the
 *    app died or hung while open (crash, freeze, OOM kill) — a report is built from the saved trail.
 * Zero dependencies (telemetry imports THIS, not the other way round). Never throws.
 */
const K_SESSION = "duo:bb:session:v1";
const K_CRUMBS = "duo:bb:crumbs:v1";
const K_REPORTS = "duo:bb:reports:v1";
const MAX_CRUMBS = 150;
const MAX_REPORTS = 6;
const BEAT_MS = 1000;
const LAG_MS = 1500;
const FREEZE_MS = 6000;

type Crumb = { t: number; k: string; m: string };
export interface BlackBoxReport {
  id: string;
  detectedAt: string;
  cause: "died-while-open" | "ended-in-background";
  summary: string;
  lastBeatAgoSec: number;
  sessionLengthSec: number;
  route: string;
  heapMB: number | null;
  lagEvents: number;
  worstLagMs: number;
  freezes: number;
  appVersion: string;
  userAgent: string;
  trail: string[];
}
interface Session {
  id: string; startedAt: number; lastBeat: number; state: "fg" | "bg";
  route: string; heapMB: number | null; lag: number; worst: number; freezes: number;
}

const safeGet = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const safeSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* full/blocked */ } };
const safeJson = <T,>(raw: string | null, fb: T): T => { try { return raw ? (JSON.parse(raw) as T) : fb; } catch { return fb; } };

let crumbs: Crumb[] = [];
let session: Session | null = null;
let pending: BlackBoxReport | null = null;
let started = false;
let dirty = false;
const listeners = new Set<(r: BlackBoxReport | null) => void>();

export function addBreadcrumb(kind: string, message: string): void {
  try {
    crumbs.push({ t: Date.now(), k: kind, m: String(message).slice(0, 160) });
    if (crumbs.length > MAX_CRUMBS) crumbs.shift();
    dirty = true;
  } catch { /* never throw */ }
}

const heapMB = (): number | null => {
  const m = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
  return m?.usedJSHeapSize ? Math.round(m.usedJSHeapSize / 1048576) : null;
};
const fmt = (c: Crumb) => `${new Date(c.t).toISOString().slice(11, 23)} [${c.k}] ${c.m}`;

function persist(): void {
  if (!session) return;
  session.heapMB = heapMB();
  session.route = location.pathname;
  safeSet(K_SESSION, JSON.stringify(session));
  if (dirty) { safeSet(K_CRUMBS, JSON.stringify(crumbs.slice(-MAX_CRUMBS))); dirty = false; }
}

function buildReport(prev: Session, prevCrumbs: Crumb[]): BlackBoxReport {
  const diedOpen = prev.state === "fg";
  const lastBeatAgo = Math.max(0, Math.round((Date.now() - prev.lastBeat) / 1000));
  const parts: string[] = [];
  if (diedOpen) parts.push("The app stopped while it was open (crash, freeze or Android killed it for memory).");
  else parts.push("The app was closed/killed by Android while in the background (usually normal; check battery optimisation if music stopped).");
  if (prev.freezes) parts.push(`${prev.freezes} freeze(s) of 6s+ were recorded.`);
  if (prev.lag) parts.push(`${prev.lag} lag spike(s), worst ${prev.worst}ms.`);
  if (prev.heapMB && prev.heapMB > 300) parts.push(`JS memory was high (${prev.heapMB} MB).`);
  return {
    id: prev.id + ":" + prev.lastBeat,
    detectedAt: new Date().toISOString(),
    cause: diedOpen ? "died-while-open" : "ended-in-background",
    summary: parts.join(" "),
    lastBeatAgoSec: lastBeatAgo,
    sessionLengthSec: Math.round((prev.lastBeat - prev.startedAt) / 1000),
    route: prev.route, heapMB: prev.heapMB, lagEvents: prev.lag, worstLagMs: prev.worst, freezes: prev.freezes,
    appVersion: String(import.meta.env?.VITE_APP_VERSION ?? "?"),
    userAgent: navigator.userAgent,
    trail: prevCrumbs.slice(-60).map(fmt),
  };
}

export function startBlackBox(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  try {
    // 1) Inspect how the PREVIOUS run ended.
    const prev = safeJson<Session | null>(safeGet(K_SESSION), null);
    const prevCrumbs = safeJson<Crumb[]>(safeGet(K_CRUMBS), []);
    if (prev && prev.lastBeat) {
      const interesting = prev.state === "fg" || prev.freezes > 0 || prev.lag >= 5;
      if (interesting) {
        const rep = buildReport(prev, prevCrumbs);
        const all = safeJson<BlackBoxReport[]>(safeGet(K_REPORTS), []);
        all.unshift(rep);
        safeSet(K_REPORTS, JSON.stringify(all.slice(0, MAX_REPORTS)));
        // Only interrupt the user for a real "died while open" or freezes.
        if (prev.state === "fg" || prev.freezes > 0) { pending = rep; listeners.forEach((l) => l(pending)); }
      }
    }
    // 2) New session.
    crumbs = [];
    session = { id: Math.random().toString(36).slice(2, 8), startedAt: Date.now(), lastBeat: Date.now(), state: "fg", route: location.pathname, heapMB: heapMB(), lag: 0, worst: 0, freezes: 0 };
    addBreadcrumb("boot", `start ${location.pathname}`);
    persist();

    // 3) Heartbeat + lag detector.
    let expected = Date.now() + BEAT_MS;
    let beats = 0;
    setInterval(() => {
      const now = Date.now();
      const drift = now - expected;
      expected = now + BEAT_MS;
      if (!session) return;
      session.lastBeat = now;
      if (document.hidden) { return; } // timers are throttled in background: don't judge
      if (drift > LAG_MS) {
        session.lag += 1; session.worst = Math.max(session.worst, drift);
        if (drift > FREEZE_MS) { session.freezes += 1; addBreadcrumb("FREEZE", `main thread blocked ~${Math.round(drift)}ms`); }
        else addBreadcrumb("lag", `main thread blocked ~${Math.round(drift)}ms`);
        persist();
      } else if (++beats % 5 === 0) persist();
    }, BEAT_MS);

    // 4) Long tasks.
    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (e.duration > 250) addBreadcrumb("longtask", `${Math.round(e.duration)}ms`);
      });
      po.observe({ entryTypes: ["longtask"] });
    } catch { /* not supported */ }

    // 5) Lifecycle + route + errors.
    document.addEventListener("visibilitychange", () => {
      if (!session) return;
      session.state = document.hidden ? "bg" : "fg";
      addBreadcrumb("vis", document.hidden ? "background" : "foreground");
      if (!document.hidden) { expected = Date.now() + BEAT_MS; }
      persist();
    });
    window.addEventListener("pagehide", () => { addBreadcrumb("pagehide", "page hidden"); persist(); });
    let lastPath = location.pathname;
    setInterval(() => { if (location.pathname !== lastPath) { lastPath = location.pathname; addBreadcrumb("route", lastPath); } }, 1000);
    window.addEventListener("error", (e) => addBreadcrumb("ERROR", `${e.message} @${(e.filename || "").split("/").pop()}:${e.lineno}`));
    window.addEventListener("unhandledrejection", (e) => addBreadcrumb("REJECT", String((e.reason as Error)?.message ?? e.reason)));
    window.addEventListener("online", () => addBreadcrumb("net", "online"));
    window.addEventListener("offline", () => addBreadcrumb("net", "offline"));
  } catch { /* the recorder must never break the app */ }
}

export const getPendingReport = (): BlackBoxReport | null => pending;
export const getReports = (): BlackBoxReport[] => safeJson<BlackBoxReport[]>(safeGet(K_REPORTS), []);
export function dismissPendingReport(): void { pending = null; listeners.forEach((l) => l(null)); }
export function clearReports(): void { safeSet(K_REPORTS, "[]"); pending = null; }
export function subscribePending(l: (r: BlackBoxReport | null) => void): () => void { listeners.add(l); return () => { listeners.delete(l); }; }
export function formatReport(r: BlackBoxReport): string {
  return [
    `DuoSpace crash/lag report — ${r.detectedAt}`,
    `Cause: ${r.cause}`, r.summary,
    `App ${r.appVersion} · screen ${r.route} · ran ${r.sessionLengthSec}s · last sign of life ${r.lastBeatAgoSec}s before this launch`,
    `Lag spikes: ${r.lagEvents} (worst ${r.worstLagMs}ms) · freezes: ${r.freezes} · heap: ${r.heapMB ?? "n/a"} MB`,
    r.userAgent, "", "Last events before it stopped:", ...r.trail,
  ].join("\n");
}

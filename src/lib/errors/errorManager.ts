/**
 * DuoSpace Error Manager.
 *
 * Single entry point for reporting errors anywhere in the app:
 *
 *   import { errorManager } from "@/lib/errors";
 *   errorManager.capture("DS-CHAT-001", { screen: "Chat", component: "MessageComposer", cause: err });
 *
 * Responsibilities:
 *  - Normalize every error into a `DuoSpaceErrorPayload` (via DuoSpaceError).
 *  - Maintain an in-memory ring buffer of recent errors for the dev log panel.
 *  - Persist an offline queue (localStorage) so errors captured while offline
 *    or mid-crash aren't lost, and flush it once a sink is attached.
 *  - Deduplicate/group repeated occurrences of the same code+message.
 *  - Track per-code frequency and recovery success/failure statistics.
 *  - Install global handlers for uncaught exceptions and unhandled promise
 *    rejections (call `errorManager.init()` once, at app boot).
 *  - Attempt automatic recovery for retryable errors via `recovery.ts`.
 *
 * This module intentionally has zero React dependency — `useErrorManager.ts`
 * and `ErrorBoundary.tsx` are the React-facing wrappers around it.
 */
import { logError as telemetryLogError, logWarn as telemetryLogWarn } from "@/lib/telemetry";
import { DuoSpaceError } from "./DuoSpaceError";
import { runRecovery } from "./recovery";
import type { CaptureOptions, DuoSpaceErrorPayload, ErrorCategory, ErrorSeverity } from "./types";

const RING_BUFFER_SIZE = 200;
const QUEUE_STORAGE_KEY = "duo:error-queue:v1";
const DEDUPE_WINDOW_MS = 3000;

type Listener = (payload: DuoSpaceErrorPayload) => void;

class ErrorManager {
  private buffer: DuoSpaceErrorPayload[] = [];
  private listeners = new Set<Listener>();
  private occurrenceCounts = new Map<string, number>();
  private lastSeenAt = new Map<string, number>();
  private frequency = new Map<string, number>();
  private initialized = false;

  /** Install global crash/rejection handlers. Call once, at app boot. */
  init(): void {
    if (this.initialized || typeof window === "undefined") return;
    this.initialized = true;

    window.addEventListener("error", (event) => {
      // Skip errors already handled by a React ErrorBoundary re-throw path,
      // and resource-load errors (img/script 404s) which have no `.error`.
      if (!event.error) return;
      this.capture("DS-UNKNOWN-001", {
        screen: "Global",
        component: "window.onerror",
        cause: event.error,
        details: { message: event.message, filename: event.filename, lineno: event.lineno },
      });
    });

    window.addEventListener("unhandledrejection", (event) => {
      this.capture("DS-UNKNOWN-001", {
        screen: "Global",
        component: "unhandledrejection",
        cause: event.reason,
        details: { reason: String(event.reason) },
      });
    });

    this.flushQueue();
  }

  /** Raise an error through the manager. Returns the normalized payload. */
  capture(code: string, options: CaptureOptions = {}): DuoSpaceErrorPayload {
    const dedupeKey = `${code}::${options.component ?? ""}::${options.action ?? ""}`;
    const now = Date.now();
    const lastAt = this.lastSeenAt.get(dedupeKey) ?? 0;
    this.lastSeenAt.set(dedupeKey, now);
    this.frequency.set(code, (this.frequency.get(code) ?? 0) + 1);

    const count = (this.occurrenceCounts.get(dedupeKey) ?? 0) + 1;
    this.occurrenceCounts.set(dedupeKey, count);

    const err = new DuoSpaceError(code, options, count);
    const payload = err.payload;

    this.record(payload);

    // Route to existing telemetry pipeline too, so nothing already relying
    // on `getRecentEvents()` / the telemetry backend sink regresses.
    const telemetryFn = payload.severity === "WARNING" || payload.severity === "INFO" ? telemetryLogWarn : telemetryLogError;
    telemetryFn(payload.component ?? payload.screen ?? payload.category, `${payload.code} ${payload.title}`, {
      details: payload.details,
      cause: options.cause,
    });

    // Only spam-dedupe the *notification* to listeners (UI), not the record —
    // repeated identical errors within the window still count toward stats
    // above, but we don't want to pop 50 toasts for one flaky loop.
    if (now - lastAt > DEDUPE_WINDOW_MS || count === 1) {
      this.notify(payload);
    }

    if (payload.retryable && payload.recoveryAction !== "none") {
      void runRecovery(payload.recoveryAction);
    }

    return payload;
  }

  private record(payload: DuoSpaceErrorPayload): void {
    this.buffer.push(payload);
    if (this.buffer.length > RING_BUFFER_SIZE) this.buffer.shift();
    this.persistQueue();
  }

  private notify(payload: DuoSpaceErrorPayload): void {
    for (const listener of this.listeners) {
      try {
        listener(payload);
      } catch { /* a bad listener must never break error reporting */ }
    }
  }

  /** Subscribe to every newly-captured error (e.g. to render a toast/card). */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── Log store / offline queue ─────────────────────────────────────────

  private persistQueue(): void {
    try {
      const recent = this.buffer.slice(-50);
      window.localStorage?.setItem(QUEUE_STORAGE_KEY, JSON.stringify(recent));
    } catch { /* storage full or unavailable — in-memory buffer still works */ }
  }

  private flushQueue(): void {
    try {
      const raw = window.localStorage?.getItem(QUEUE_STORAGE_KEY);
      if (!raw) return;
      const queued = JSON.parse(raw) as DuoSpaceErrorPayload[];
      if (Array.isArray(queued) && queued.length && this.buffer.length === 0) {
        // Restore prior session's tail into the buffer so a crash-and-reload
        // still shows recent history in the dev log panel.
        this.buffer = queued.slice(-RING_BUFFER_SIZE);
      }
    } catch { /* corrupted queue — ignore */ }
  }

  // ── Querying (used by ErrorLogPanel) ───────────────────────────────────

  getAll(): readonly DuoSpaceErrorPayload[] {
    return [...this.buffer];
  }

  search(query: string): DuoSpaceErrorPayload[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.getAll() as DuoSpaceErrorPayload[];
    return this.buffer.filter(
      (e) =>
        e.code.toLowerCase().includes(q) ||
        e.title.toLowerCase().includes(q) ||
        e.message.toLowerCase().includes(q) ||
        (e.screen ?? "").toLowerCase().includes(q) ||
        (e.component ?? "").toLowerCase().includes(q),
    );
  }

  filterByCategory(category: ErrorCategory | "All"): DuoSpaceErrorPayload[] {
    if (category === "All") return this.getAll() as DuoSpaceErrorPayload[];
    return this.buffer.filter((e) => e.category === category);
  }

  filterBySeverity(severity: ErrorSeverity | "All"): DuoSpaceErrorPayload[] {
    if (severity === "All") return this.getAll() as DuoSpaceErrorPayload[];
    return this.buffer.filter((e) => e.severity === severity);
  }

  /** Per-code occurrence counts this session, most frequent first. */
  getFrequencyStats(): Array<{ code: string; count: number }> {
    return [...this.frequency.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count);
  }

  exportLogsAsJson(): string {
    return JSON.stringify(this.buffer, null, 2);
  }

  copyDiagnostics(payload: DuoSpaceErrorPayload): string {
    return [
      `Code: ${payload.code}`,
      `Title: ${payload.title}`,
      `Category: ${payload.category} | Severity: ${payload.severity}`,
      `Screen: ${payload.screen ?? "—"} | Component: ${payload.component ?? "—"}`,
      `Timestamp: ${payload.timestamp}`,
      `Session: ${payload.sessionId}`,
      `App version: ${payload.appVersion}`,
      `Device: ${payload.device.platform} (${payload.device.isNative ? "native" : "web"}), online=${payload.device.online}, ${payload.device.viewport}`,
      `Occurrences: ${payload.occurrenceCount}`,
      payload.details ? `Details: ${JSON.stringify(payload.details)}` : undefined,
      // BUG FIX: Copy/Report Bug used to omit the one field that actually
      // identifies what broke. `payload.message` is a canned per-code string
      // from the registry (e.g. "Something went wrong" for every
      // DS-UNKNOWN-001), but `payload.stack` — captured from the *real*
      // thrown Error in DuoSpaceError's constructor — has the real
      // `Name: message` on its first line even in a minified production
      // build (JS error messages aren't touched by minification, only
      // identifiers are). Without this, every copied/reported crash was
      // indistinguishable from every other crash with the same DS code.
      payload.stack ? `Stack: ${payload.stack}` : undefined,
    ]
      .filter(Boolean)
      .join("\n");
  }

  clear(): void {
    this.buffer = [];
    this.occurrenceCounts.clear();
    this.lastSeenAt.clear();
    this.frequency.clear();
    try {
      window.localStorage?.removeItem(QUEUE_STORAGE_KEY);
    } catch { /* noop */ }
  }
}

/** App-wide singleton. Import this, don't construct `ErrorManager` yourself. */
export const errorManager = new ErrorManager();

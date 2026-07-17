/**
 * Centralized error telemetry for DuoSpace.
 *
 * FIX #13: Replaces scattered console.error calls with a single reporting point.
 * Replace console.error / console.warn throughout the codebase with these helpers.
 *
 * In production, swap the body of `sendToBackend` to POST to your error-tracking
 * service (e.g. Sentry, LogRocket, or a custom Supabase Edge Function).
 *
 * Usage:
 *   import { logError, logWarn } from "@/lib/telemetry";
 *   logError("useDailyCall", "room creation failed", err);
 */

type Severity = "error" | "warn" | "info";

interface ErrorEvent {
  context: string;
  message: string;
  severity: Severity;
  timestamp: string;
  sessionId: string;
  traceId?: string;
  extra?: Record<string, unknown>;
}

/** Per-app-load correlation ID — lets you stitch logs from one runtime together. */
const SESSION_ID = (() => {
  try {
    const c = (globalThis.crypto as Crypto | undefined);
    return c?.randomUUID?.() ?? `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  } catch { return `s_${Date.now().toString(36)}`; }
})();
export const getSessionId = () => SESSION_ID;

/** Mint a short trace ID for a single lifecycle (one call, one backup, one camera lease). */
export const newTraceId = (prefix = "t") =>
  `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

const RING_BUFFER_SIZE = 50;
const recentEvents: ErrorEvent[] = [];

// Rate limiter: drop duplicate (context+message) within 2s window.
const lastSeen = new Map<string, number>();
const RATE_WINDOW_MS = 2000;
function shouldEmit(context: string, message: string): boolean {
  const key = `${context}::${message}`;
  const now = Date.now();
  const prev = lastSeen.get(key) ?? 0;
  if (now - prev < RATE_WINDOW_MS) return false;
  lastSeen.set(key, now);
  // Bound the map.
  if (lastSeen.size > 200) {
    const cutoff = now - RATE_WINDOW_MS * 5;
    for (const [k, t] of lastSeen) if (t < cutoff) lastSeen.delete(k);
  }
  return true;
}

function record(event: ErrorEvent): void {
  recentEvents.push(event);
  if (recentEvents.length > RING_BUFFER_SIZE) recentEvents.shift();
}

/**
 * Returns a snapshot of recent events for debugging.
 * Call this in a crash-reporting screen or a hidden dev panel.
 */
export function getRecentEvents(): Readonly<ErrorEvent[]> {
  return [...recentEvents];
}

/**
 * Clear the in-memory event buffer (e.g. after upload to backend).
 * Also resets the rate-limit window so subsequent identical events emit again.
 */
export function clearEvents(): void {
  recentEvents.length = 0;
  lastSeen.clear();
}

/**
 * Send an event to the backend telemetry sink.
 * Swap this implementation to integrate with Sentry, PostHog, etc.
 */
async function sendToBackend(event: ErrorEvent): Promise<void> {
  // TODO: Replace with real backend call when telemetry service is chosen.
  // Example:
  //   await fetch("/api/telemetry", { method: "POST", body: JSON.stringify(event) });
  void event; // no-op until backend is wired
}

function formatExtra(err: unknown): Record<string, unknown> | undefined {
  if (!err) return undefined;
  if (err instanceof Error) {
    return { name: err.name, stack: err.stack?.split("\n").slice(0, 5).join("\n") };
  }
  return { raw: String(err) };
}

/** Log a non-fatal warning. Does not send to backend. */
export function logWarn(context: string, message: string, extra?: unknown, traceId?: string): void {
  if (!shouldEmit(context, message)) return;
  const event: ErrorEvent = {
    context, message, severity: "warn",
    timestamp: new Date().toISOString(),
    sessionId: SESSION_ID, traceId,
    extra: formatExtra(extra),
  };
  record(event);
  if (import.meta.env.DEV) console.warn(`[${context}${traceId ? `:${traceId}` : ""}] ${message}`, extra ?? "");
}

/** Log an error and send it to the telemetry backend. */
export function logError(context: string, message: string, err?: unknown, traceId?: string): void {
  if (!shouldEmit(context, message)) return;
  const event: ErrorEvent = {
    context, message, severity: "error",
    timestamp: new Date().toISOString(),
    sessionId: SESSION_ID, traceId,
    extra: formatExtra(err),
  };
  record(event);
  // Only echo to the browser console in development. Production errors still
  // flow to sendToBackend() below — console.error was previously unconditional
  // here (unlike logWarn/logInfo), so every production build leaked internal
  // error detail (traceIds, provider errors, stack fragments) into the
  // devtools console for any user to see.
  if (import.meta.env.DEV) console.error(`[${context}${traceId ? `:${traceId}` : ""}] ${message}`, err ?? "");
  sendToBackend(event).catch(() => { /* telemetry must never throw */ });
}

/** Log an informational event (e.g. "backup started"). */
export function logInfo(context: string, message: string, extra?: unknown, traceId?: string): void {
  if (!shouldEmit(context, message)) return;
  const event: ErrorEvent = {
    context, message, severity: "info",
    timestamp: new Date().toISOString(),
    sessionId: SESSION_ID, traceId,
    extra: formatExtra(extra),
  };
  record(event);
  if (import.meta.env.DEV) console.info(`[${context}${traceId ? `:${traceId}` : ""}] ${message}`, extra ?? "");
}

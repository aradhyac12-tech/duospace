/**
 * DuoSpaceError — the normalized error object at the heart of the error system.
 *
 * `new DuoSpaceError(code, options)` is the one thing every call site needs
 * to construct a fully-populated, typed error: it looks up the code's static
 * metadata in the registry, then fills in everything else (timestamp,
 * session id, device info, stack) automatically.
 */
import { Capacitor } from "@capacitor/core";
import { getSessionId } from "@/lib/telemetry";
import { getErrorDefinition } from "./registry";
import type { CaptureOptions, DeviceInfo, DuoSpaceErrorPayload } from "./types";

// STRICT RULE — bump this on every change that ships (any commit that
// touches src/, supabase/, or native/), and keep it in lock-step with
// package.json's "version" field. This is shown to the user directly in
// Settings ("DuoSpace v{APP_VERSION}") and stamped into every captured
// error report, so a stale value here silently misleads both support and
// the user about what build they're running. Use semver (MAJOR.MINOR.PATCH,
// e.g. "1.2.3"): PATCH for fixes, MINOR for new features, MAJOR for
// breaking changes. See "Version bump rule" in docs/rules.md — this is not
// optional/stylistic, it's load-bearing for support and telemetry.
export const APP_VERSION = (import.meta.env.VITE_APP_VERSION as string | undefined) ?? "3.4.0";

function getDeviceInfo(): DeviceInfo {
  let platform = "web";
  let isNative = false;
  try {
    platform = Capacitor.getPlatform();
    isNative = Capacitor.isNativePlatform();
  } catch { /* Capacitor not initialized (e.g. tests) */ }
  return {
    platform,
    isNative,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
    online: typeof navigator !== "undefined" ? navigator.onLine : true,
    viewport: typeof window !== "undefined" ? `${window.innerWidth}x${window.innerHeight}` : "unknown",
  };
}

function extractStack(cause: unknown): string | undefined {
  if (cause instanceof Error) return cause.stack;
  if (cause && typeof cause === "object" && "stack" in cause) {
    const s = (cause as { stack?: unknown }).stack;
    return typeof s === "string" ? s : undefined;
  }
  return undefined;
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `dse_${Date.now().toString(36)}_${idCounter}`;
}

export class DuoSpaceError extends Error {
  readonly payload: DuoSpaceErrorPayload;

  constructor(code: string, options: CaptureOptions = {}, occurrenceCount = 1) {
    const def = getErrorDefinition(code);
    super(def.message);
    this.name = "DuoSpaceError";

    this.payload = {
      id: nextId(),
      code: def.code,
      category: def.category,
      severity: def.severity,
      title: def.title,
      message: def.message,
      recoverySuggestion: def.recoverySuggestion,
      retryable: options.retryable ?? def.retryable,
      recoveryAction: def.recoveryAction,
      screen: options.screen,
      component: options.component,
      action: options.action,
      timestamp: new Date().toISOString(),
      sessionId: getSessionId(),
      appVersion: APP_VERSION,
      device: getDeviceInfo(),
      details: options.details,
      stack: extractStack(options.cause) ?? new Error().stack,
      occurrenceCount,
    };
  }
}

/** Convenience factory — equivalent to `new DuoSpaceError(...)` but reads nicer at call sites. */
export function createDuoSpaceError(code: string, options?: CaptureOptions): DuoSpaceError {
  return new DuoSpaceError(code, options);
}

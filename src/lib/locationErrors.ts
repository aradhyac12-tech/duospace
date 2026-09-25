/**
 * locationErrors — pure classification of geolocation failures.
 *
 * WHY THIS EXISTS (fix, 2026-09-20 — "Location Access Required / Location
 * timed out. / Request Permission"): MapView used to show its blocking
 * "Location Access Required" screen for ANY location error string,
 * including a plain GPS timeout on a device where permission was already
 * granted. Those are different problems with different remedies:
 *
 *   denied      – the person (or OS) refused permission. The only fix is
 *                 permission (prompt again, or Settings). Blocking screen
 *                 is correct here.
 *   unavailable – permission is fine but no position could be produced
 *                 (location services switched off, no signal source).
 *   timeout     – permission is fine, the receiver just hasn't produced a
 *                 fix inside the time budget (cold GPS, indoors, weak
 *                 signal). Transient; the watcher keeps trying and the next
 *                 fix clears it.
 *
 * Kept free of imports (no Capacitor, no Supabase) so it can be unit
 * tested in isolation — see src/test/locationErrors.test.ts.
 */

export type LocationErrorKind = "denied" | "unavailable" | "timeout";

/** Web `GeolocationPositionError.code` values. */
export const GEO_PERMISSION_DENIED = 1;
export const GEO_POSITION_UNAVAILABLE = 2;
export const GEO_TIMEOUT = 3;

export interface NormalizedGeoError {
  code: 1 | 2 | 3;
  message: string;
}

/**
 * `@capacitor/geolocation`'s native errors don't carry the web API's
 * numeric `.code` — they arrive as `{ message }`. Map them back onto the
 * web codes so both platforms share one error-handling path.
 *
 * Matching is by lower-cased substring and is best-effort: the plugin's
 * wording is small and stable but not a documented contract. Anything
 * unrecognised is treated as a timeout (the most common and most
 * recoverable failure), never as a permission denial — misclassifying
 * something as "denied" is the worse mistake because it puts up the
 * blocking permission screen.
 *
 * Note the "services off" wording ("Location services are not enabled")
 * deliberately maps to UNAVAILABLE, not timeout: the old matcher only
 * looked for "unavailable"/"disabled", so that message fell through to
 * TIMEOUT and showed "Location timed out." on a phone whose GPS toggle was
 * simply off.
 */
export function normalizeNativeGeoError(err: unknown): NormalizedGeoError {
  const raw = (err as { message?: unknown } | null | undefined)?.message;
  const message = typeof raw === "string" ? raw : "";
  const m = message.toLowerCase();

  if (m.includes("denied") || m.includes("permission")) {
    return { code: GEO_PERMISSION_DENIED, message };
  }
  if (
    m.includes("not enabled") ||
    m.includes("disabled") ||
    m.includes("location services") ||
    m.includes("unavailable")
  ) {
    return { code: GEO_POSITION_UNAVAILABLE, message };
  }
  return { code: GEO_TIMEOUT, message };
}

/** True when the failure text says location services are switched off. */
export function isServicesOffMessage(message: string | undefined | null): boolean {
  const m = (message ?? "").toLowerCase();
  return m.includes("not enabled") || m.includes("disabled") || m.includes("location services") || m.includes("turned off");
}

export interface DescribedGeoError {
  kind: LocationErrorKind;
  /** Short, person-facing sentence stored as the hook's `error` string. */
  text: string;
}

/** Turn a (web-shaped) geolocation error into the kind + text the UI shows. */
export function describeGeoError(err: { code?: number; message?: string }): DescribedGeoError {
  if (err.code === GEO_PERMISSION_DENIED) {
    return { kind: "denied", text: "Location access denied." };
  }
  if (err.code === GEO_POSITION_UNAVAILABLE) {
    return {
      kind: "unavailable",
      text: isServicesOffMessage(err.message)
        ? "Location services are turned off on this device."
        : "Location unavailable.",
    };
  }
  return { kind: "timeout", text: "Location timed out." };
}

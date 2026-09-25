/**
 * Runtime side of the sensor policy: reads the persisted opt-ins and
 * enforces sensorPolicy.evaluateSensorRequest(). Kept separate from the
 * pure policy so that file stays importable without touching storage.
 *
 * Reads localStorage on every call rather than caching, so flipping a
 * toggle OFF takes effect on the very next acquisition — "disabling
 * consent actually prevents processing" — without a reload.
 */
import storage from "@/lib/storage";
import {
  evaluateSensorRequest,
  parseSensorSettings,
  type SensorRequestContext,
  type SensorSettings,
} from "./sensorPolicy";

export const SETTINGS_STORAGE_KEY = "duo-settings";

export class SensorDeniedError extends Error {
  readonly purpose: string;
  constructor(purpose: string, reason: string) {
    super(`Sensor access denied for ${purpose}: ${reason}`);
    this.name = "SensorDeniedError";
    this.purpose = purpose;
  }
}

export function readSensorSettings(): SensorSettings {
  return parseSensorSettings(storage.get(SETTINGS_STORAGE_KEY));
}

/** Throws SensorDeniedError unless the purpose is registered and currently permitted. */
export function assertSensorAllowed(purposeId: string, ctx: SensorRequestContext = {}): void {
  const decision = evaluateSensorRequest(purposeId, readSensorSettings(), ctx);
  if (!decision.allowed) throw new SensorDeniedError(purposeId, decision.reason);
}

/**
 * Tests for src/lib/locationErrors.ts — the classification behind the fix
 * for "Location Access Required / Location timed out. / Request Permission"
 * (2026-09-20). Pure functions, no mocking needed.
 */
import { describe, it, expect } from "vitest";
import {
  normalizeNativeGeoError,
  describeGeoError,
  isServicesOffMessage,
} from "@/lib/locationErrors";

describe("normalizeNativeGeoError", () => {
  it("maps permission wording to code 1 (denied)", () => {
    expect(normalizeNativeGeoError({ message: "Location permission was denied" }).code).toBe(1);
    expect(normalizeNativeGeoError({ message: "User denied Geolocation" }).code).toBe(1);
  });

  it("maps 'services not enabled' to code 2 (unavailable), NOT timeout", () => {
    // Regression: this used to fall through to code 3 and surface as
    // "Location timed out." on a phone whose location toggle was just off.
    expect(normalizeNativeGeoError({ message: "Location services are not enabled" }).code).toBe(2);
    expect(normalizeNativeGeoError({ message: "Location services disabled" }).code).toBe(2);
    expect(normalizeNativeGeoError({ message: "Location unavailable" }).code).toBe(2);
  });

  it("treats timeouts and anything unrecognised as code 3, never as denied", () => {
    expect(normalizeNativeGeoError({ message: "Location request timed out" }).code).toBe(3);
    expect(normalizeNativeGeoError({ message: "something totally unexpected" }).code).toBe(3);
    expect(normalizeNativeGeoError(undefined).code).toBe(3);
    expect(normalizeNativeGeoError(null).code).toBe(3);
    expect(normalizeNativeGeoError({}).code).toBe(3);
    expect(normalizeNativeGeoError({ message: 42 }).code).toBe(3);
  });

  it("is case-insensitive and preserves the original message", () => {
    const r = normalizeNativeGeoError({ message: "PERMISSION Denied" });
    expect(r.code).toBe(1);
    expect(r.message).toBe("PERMISSION Denied");
  });
});

describe("describeGeoError", () => {
  it("code 1 -> denied", () => {
    expect(describeGeoError({ code: 1 })).toEqual({ kind: "denied", text: "Location access denied." });
  });

  it("code 2 -> unavailable, with distinct text when services are off", () => {
    expect(describeGeoError({ code: 2, message: "Position update is unavailable" }))
      .toEqual({ kind: "unavailable", text: "Location unavailable." });
    expect(describeGeoError({ code: 2, message: "Location services are not enabled" }))
      .toEqual({ kind: "unavailable", text: "Location services are turned off on this device." });
  });

  it("code 3 (and anything else) -> timeout", () => {
    expect(describeGeoError({ code: 3 })).toEqual({ kind: "timeout", text: "Location timed out." });
    expect(describeGeoError({})).toEqual({ kind: "timeout", text: "Location timed out." });
  });
});

describe("isServicesOffMessage", () => {
  it("detects services-off wording and ignores everything else", () => {
    expect(isServicesOffMessage("Location services are not enabled")).toBe(true);
    expect(isServicesOffMessage("Location services disabled")).toBe(true);
    expect(isServicesOffMessage("Timeout expired")).toBe(false);
    expect(isServicesOffMessage(undefined)).toBe(false);
    expect(isServicesOffMessage(null)).toBe(false);
  });
});

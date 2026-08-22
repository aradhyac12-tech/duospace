/**
 * Tests for telemetry.ts (centralized error logging).
 * FIX AUDIT #1: Part of the regression suite.
 * FIX AUDIT #2: Validates that errors are captured, not silently swallowed.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  logError,
  logWarn,
  logInfo,
  getRecentEvents,
  clearEvents,
} from "@/lib/telemetry";

describe("telemetry", () => {
  beforeEach(() => {
    clearEvents();
  });

  it("logError records an event with error severity", () => {
    logError("test", "something broke");
    const events = getRecentEvents();
    expect(events).toHaveLength(1);
    expect(events[0].severity).toBe("error");
    expect(events[0].context).toBe("test");
    expect(events[0].message).toBe("something broke");
  });

  it("logWarn records a warn event", () => {
    logWarn("test", "watch out");
    const events = getRecentEvents();
    expect(events[0].severity).toBe("warn");
  });

  it("logInfo records an info event", () => {
    logInfo("test", "all good");
    const events = getRecentEvents();
    expect(events[0].severity).toBe("info");
  });

  it("events include an ISO timestamp", () => {
    logError("test", "err");
    const ts = getRecentEvents()[0].timestamp;
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("clearEvents empties the buffer", () => {
    logError("a", "b");
    logError("c", "d");
    clearEvents();
    expect(getRecentEvents()).toHaveLength(0);
  });

  it("ring buffer does not grow beyond 50", () => {
    for (let i = 0; i < 60; i++) logInfo("test", `event ${i}`);
    expect(getRecentEvents()).toHaveLength(50);
  });

  it("logError extracts Error stack info", () => {
    logError("test", "err", new Error("boom"));
    const extra = getRecentEvents()[0].extra;
    expect(extra).toBeDefined();
    expect(extra?.name).toBe("Error");
  });

  it("logError handles non-Error extras gracefully", () => {
    logError("test", "err", "plain string");
    const extra = getRecentEvents()[0].extra;
    expect(extra?.raw).toBe("plain string");
  });

  it("getRecentEvents returns a copy, not the live array", () => {
    logError("test", "a");
    const snap1 = getRecentEvents();
    logError("test", "b");
    const snap2 = getRecentEvents();
    expect(snap1).toHaveLength(1);
    expect(snap2).toHaveLength(2);
  });
});

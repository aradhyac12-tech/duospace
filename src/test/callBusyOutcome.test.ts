import { describe, it, expect } from "vitest";
import { classifyCallOutcome } from "@/lib/callOutcome";

describe("busy auto-decline outcome", () => {
  const base = { duration_seconds: 0, declined_at: "2026-10-06T10:00:00Z" };
  it("missed + declined_at + cancel_reason=busy is 'busy', not 'declined'", () => {
    expect(classifyCallOutcome({ ...base, status: "missed", cancel_reason: "busy" })).toBe("busy");
  });
  it("a normal decline is still 'declined'", () => {
    expect(classifyCallOutcome({ ...base, status: "missed", cancel_reason: null })).toBe("declined");
  });
  it("no declined_at and no reason is still 'missed'", () => {
    expect(classifyCallOutcome({ duration_seconds: 0, declined_at: null, status: "missed" })).toBe("missed");
  });
  it("cancel_reason=busy never overrides a connected call", () => {
    expect(classifyCallOutcome({ duration_seconds: 30, declined_at: null, status: "completed", cancel_reason: "busy" })).toBe("answered");
  });
});

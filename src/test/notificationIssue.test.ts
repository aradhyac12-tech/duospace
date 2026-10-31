import { describe, it, expect } from "vitest";
import { describeNotificationIssue, createIssueDeduper } from "@/lib/music/notificationIssue";

describe("describeNotificationIssue", () => {
  it("offers the settings button when the fix is an OS setting", () => {
    for (const r of ["APP_NOTIFICATIONS_DISABLED", "CHANNEL_BLOCKED", "CHANNEL_MISSING", "NOT_ACTIVE"]) {
      expect(describeNotificationIssue(r).canOpenSettings).toBe(true);
    }
  });
  it("POST_FAILED carries a message suffix and has no settings button", () => {
    const info = describeNotificationIssue("POST_FAILED: Bad notification for startForeground");
    expect(info.canOpenSettings).toBe(false);
    expect(info.title).toMatch(/couldn't show/i);
  });
  it("unknown / empty reasons still produce a usable message", () => {
    for (const r of ["SOMETHING_NEW", "", undefined as unknown as string]) {
      const info = describeNotificationIssue(r);
      expect(info.title.length).toBeGreaterThan(0);
      expect(info.description.length).toBeGreaterThan(0);
    }
  });
  it("never describes a missing notification as a playback failure", () => {
    for (const r of ["APP_NOTIFICATIONS_DISABLED", "CHANNEL_BLOCKED", "NOT_ACTIVE", "POST_FAILED: x", "?"]) {
      const info = describeNotificationIssue(r);
      expect(`${info.title} ${info.description}`).not.toMatch(/can't be played|playback (failed|error)/i);
    }
  });
});

describe("createIssueDeduper", () => {
  it("is true once per reason code, ignoring any message suffix", () => {
    const seen = createIssueDeduper();
    expect(seen("CHANNEL_BLOCKED")).toBe(true);
    expect(seen("CHANNEL_BLOCKED")).toBe(false);
    expect(seen("POST_FAILED: a")).toBe(true);
    expect(seen("POST_FAILED: b")).toBe(false);
    expect(seen("NOT_ACTIVE")).toBe(true);
  });
  it("separate instances (separate sessions) don't share state", () => {
    expect(createIssueDeduper()("NOT_ACTIVE")).toBe(true);
    expect(createIssueDeduper()("NOT_ACTIVE")).toBe(true);
  });
});

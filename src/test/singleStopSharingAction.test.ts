import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const sql = readFileSync("supabase/migrations/20261003150000_single_stop_sharing_unlink_action.sql", "utf8");
const ui = readFileSync("src/pages/settings/PartnerSettings.tsx", "utf8");

describe("one action: Stop sharing & unlink", () => {
  it("schedule_unlink() can't start a countdown without stopping sharing", () => {
    expect(sql).toMatch(/FUNCTION public\.schedule_unlink\(\)[\s\S]*public\.stop_sharing\(\)/);
    expect(sql).toMatch(/SET SCHEMA private/);
  });
  it("the ask-your-partner unlink was retired here, then restored as the 2nd option", () => {
    expect(sql).toMatch(/USE_STOP_SHARING/);
    const restore = readFileSync("supabase/migrations/20261009100000_restore_request_unlink.sql", "utf8");
    expect(restore).toMatch(/FUNCTION public\.request_unlink\(\)/);
    // Ignore SQL comments: the header explains the history and mentions the old code by name.
    const restoreCode = restore.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(restoreCode).not.toMatch(/USE_STOP_SHARING/);
  });
  it("any ended pairing clears the restriction for both people", () => {
    expect(sql).toMatch(/DELETE FROM public\.sharing_state WHERE user_id IN \(_a, _b\)/);
  });
  it("the settings screen offers exactly two unlink options: request, and stop sharing (14 days)", () => {
    expect(ui).not.toMatch(/setShowUnlinkConfirm/);
    expect(ui.match(/setShowRequestConfirm\(true\)/g)?.length).toBe(1);
    expect(ui.match(/setShowStopSharingConfirm\(true\)/g)?.length).toBe(1);
  });
});

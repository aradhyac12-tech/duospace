import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { describeScheduleError } from "@/lib/scheduledUnlink";

const sql = readFileSync(
  "supabase/migrations/20261003120000_stop_sharing_starts_irreversible_unlink.sql",
  "utf8",
);

describe("stop sharing starts an irreversible 14-day unlink", () => {
  it("stop_sharing() schedules the unlink", () => {
    const fn = sql.slice(sql.indexOf("FUNCTION public.stop_sharing"), sql.indexOf("FUNCTION public.cancel_scheduled_unlink"));
    expect(fn).toMatch(/public\.schedule_unlink\(\)/);
  });
  it("cancel always refuses and resume refuses while counting down", () => {
    expect(sql).toMatch(/cancel_scheduled_unlink[\s\S]*'IRREVERSIBLE'/);
    expect(sql).toMatch(/resume_sharing[\s\S]*status = 'scheduled'[\s\S]*'IRREVERSIBLE'/);
  });
  it("the guard trigger makes 'cancelled' unreachable", () => {
    expect(sql).toMatch(/an unlink cannot be cancelled/);
  });
  it("has a user-facing message for IRREVERSIBLE", () => {
    expect(describeScheduleError("IRREVERSIBLE")).toMatch(/can't be undone/i);
  });
});

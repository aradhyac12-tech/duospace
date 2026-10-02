import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

vi.mock("@/integrations/supabase/appClient", () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));

import {
  SCHEDULED_UNLINK_DAYS, daysUntil, describeCountdown, describeScheduleError, isDue,
  hasHandledExecuted, markHandledExecuted,
} from "@/lib/scheduledUnlink";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const DAY = 86_400_000;

describe("scheduled unlink helpers", () => {
  it("uses a 14 day delay (wording only; the server fixes the real date)", () => {
    expect(SCHEDULED_UNLINK_DAYS).toBe(14);
  });

  it("rounds days up so '1 day' shows until it is actually due", () => {
    expect(daysUntil(new Date(NOW + 14 * DAY).toISOString(), NOW)).toBe(14);
    expect(daysUntil(new Date(NOW + 3 * DAY - 1000).toISOString(), NOW)).toBe(3);
    expect(daysUntil(new Date(NOW + 1000).toISOString(), NOW)).toBe(1);
  });

  it("is zero once due or for garbage input", () => {
    expect(daysUntil(new Date(NOW).toISOString(), NOW)).toBe(0);
    expect(daysUntil(new Date(NOW - DAY).toISOString(), NOW)).toBe(0);
    expect(daysUntil("not-a-date", NOW)).toBe(0);
    expect(isDue({ execute_at: "not-a-date" }, NOW)).toBe(false);
  });

  it("describes the countdown", () => {
    expect(describeCountdown(new Date(NOW + DAY).toISOString(), NOW)).toBe("in 1 day");
    expect(describeCountdown(new Date(NOW + 5 * DAY).toISOString(), NOW)).toBe("in 5 days");
    expect(describeCountdown(new Date(NOW - 1).toISOString(), NOW)).toBe("any moment now");
  });

  it("has specific error text and a safe default", () => {
    expect(describeScheduleError("NOT_LINKED")).toMatch(/not linked/i);
    expect(describeScheduleError("NOT_FOUND")).toMatch(/finished|cancelled/i);
    expect(describeScheduleError("WHATEVER")).toMatch(/try again/i);
  });

  describe("handled-executed memory", () => {
    beforeEach(() => localStorage.clear());
    it("remembers an id once, and keeps only the most recent 20", () => {
      expect(hasHandledExecuted("a")).toBe(false);
      markHandledExecuted("a");
      markHandledExecuted("a");
      expect(hasHandledExecuted("a")).toBe(true);
      for (let i = 0; i < 25; i++) markHandledExecuted(`id-${i}`);
      expect(hasHandledExecuted("a")).toBe(false);
      expect(hasHandledExecuted("id-24")).toBe(true);
    });
  });
});

const read = (f: string) =>
  readFileSync(path.resolve(__dirname, "../../supabase/migrations", f), "utf8");

// Not live-DB tests: these pin the properties that make the rules enforceable,
// so editing them away fails loudly instead of the rule silently lapsing.
describe("20261002120000_scheduled_unilateral_unlink.sql (static checks)", () => {
  const sql = read("20261002120000_scheduled_unilateral_unlink.sql");

  it("fixes the delay on the server and makes the table read-only for clients", () => {
    expect(sql).toMatch(/execute_at\s+timestamptz NOT NULL DEFAULT \(now\(\) \+ interval '14 days'\)/);
    expect(sql).toMatch(/GRANT SELECT ON public\.scheduled_unlinks TO authenticated/);
    expect(sql).not.toMatch(/GRANT[^;]*(INSERT|UPDATE|DELETE)[^;]*ON public\.scheduled_unlinks TO authenticated/i);
    expect(sql).not.toMatch(/CREATE POLICY[^;]*ON public\.scheduled_unlinks\s+FOR (INSERT|UPDATE|DELETE)/i);
  });

  it("freezes identity and dates, and never reopens a finished schedule", () => {
    expect(sql).toMatch(/NEW\.execute_at IS DISTINCT FROM OLD\.execute_at/);
    expect(sql).toMatch(/a finished schedule cannot be reopened/);
  });

  it("only the requester can cancel; the partner cannot block it", () => {
    const fn = sql.slice(sql.indexOf("FUNCTION public.cancel_scheduled_unlink"), sql.indexOf("-- 5. Execution"));
    expect(fn).toMatch(/WHERE id = p_id AND requester_id = v_uid AND status = 'scheduled'/);
  });

  it("never severs a different pairing than the one scheduled", () => {
    const fn = sql.slice(sql.indexOf("FUNCTION private.execute_scheduled_unlink"), sql.indexOf("FUNCTION public.execute_due_unlinks"));
    expect(fn).toMatch(/b\.partner_id = a\.user_id/);
    expect(fn).toMatch(/status = 'void'/);
  });

  it("ends through the same apply_unlink as the consent path", () => {
    expect(sql).toMatch(/PERFORM private\.apply_unlink\(v_row\.requester_id, v_row\.partner_id\)/);
    expect(sql).toMatch(/PERFORM public\.revoke_relationship_shares_between\(_a, _b\)/);
  });

  it("keeps the sweep service-role only and the lazy path caller-scoped", () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.execute_due_unlinks\(\) FROM PUBLIC, anon, authenticated/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.execute_due_unlinks\(\) TO service_role/);
    expect(sql).toMatch(/AND \(requester_id = v_uid OR partner_id = v_uid\)/);
  });

  it("does not touch the consent-based unlink RPCs", () => {
    expect(sql).not.toMatch(/FUNCTION public\.(request_unlink|respond_unlink|cancel_unlink)\b/);
  });
});

describe("20261002110000_stop_sharing.sql (static checks)", () => {
  const sql = read("20261002110000_stop_sharing.sql");

  it("is unilateral and idempotent, and clients cannot write the state table", () => {
    expect(sql).toMatch(/GRANT SELECT ON public\.sharing_state TO authenticated/);
    expect(sql).not.toMatch(/GRANT[^;]*(INSERT|UPDATE|DELETE)[^;]*ON public\.sharing_state TO authenticated/i);
    expect(sql).toMatch(/ON CONFLICT \(user_id\) DO NOTHING/);
  });

  it("enforces in the database, including for service-role writers", () => {
    expect(sql).toMatch(/CREATE TRIGGER locations_block_stopped_trg\s+BEFORE INSERT OR UPDATE ON public\.locations/);
    expect(sql).toMatch(/CREATE TRIGGER profiles_device_status_stopped_trg/);
    expect(sql).toMatch(/CREATE TRIGGER relationship_shares_block_stopped_trg\s+BEFORE INSERT ON public\.relationship_shares/);
  });

  it("only revokes shares the caller owns, and does not touch presence columns", () => {
    expect(sql).toMatch(/WHERE owner_id = v_uid AND revoked_at IS NULL/);
    expect(sql).not.toMatch(/last_seen_at\s*=|tracking_state\s*=|app_visibility\s*=/);
  });

  it("is not narrated to the partner (no push)", () => {
    expect(sql).not.toMatch(/dispatch_push/);
  });
});

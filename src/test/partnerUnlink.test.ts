import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

vi.mock("@/integrations/supabase/appClient", () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));

import {
  isOpenRequest, describeUnlinkError, markPartnerUnlinked, consumeUnlinkNotice,
} from "@/lib/partnerUnlink";
import { getCachedPartner, setCachedPartner, clearCachedPartner } from "@/lib/partnerCache";

const NOW = Date.parse("2026-09-20T12:00:00Z");

describe("isOpenRequest", () => {
  it("is open while pending and before expiry", () => {
    expect(isOpenRequest({ status: "pending", expires_at: "2026-09-27T12:00:00Z" }, NOW)).toBe(true);
  });
  it("is closed once expired, even if the row still says pending", () => {
    expect(isOpenRequest({ status: "pending", expires_at: "2026-09-20T11:59:59Z" }, NOW)).toBe(false);
  });
  it.each(["approved", "declined", "cancelled", "expired"] as const)("is closed when %s", (status) => {
    expect(isOpenRequest({ status, expires_at: "2026-09-27T12:00:00Z" }, NOW)).toBe(false);
  });
});

describe("describeUnlinkError", () => {
  it("gives a specific message for known codes and a safe default otherwise", () => {
    expect(describeUnlinkError("EXPIRED")).toMatch(/expired/i);
    expect(describeUnlinkError("NOT_LINKED")).toMatch(/not linked/i);
    expect(describeUnlinkError("ALREADY_HANDLED")).toMatch(/already answered/i);
    expect(describeUnlinkError("SOMETHING_NEW")).toMatch(/try again/i);
    expect(describeUnlinkError(undefined)).toMatch(/try again/i);
  });
});

describe("markPartnerUnlinked", () => {
  beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });

  it("forgets the cached partner so a cold start can't pre-fill the ex-partner", () => {
    setCachedPartner("me", { partnerId: "p1", partnerName: "P", partnerAvatar: null });
    expect(getCachedPartner("me")).not.toBeNull();
    markPartnerUnlinked("me");
    expect(getCachedPartner("me")).toBeNull();
  });

  it("leaves a one-shot notice for the post-reload toast", () => {
    markPartnerUnlinked("me");
    expect(consumeUnlinkNotice()).toBe(true);
    expect(consumeUnlinkNotice()).toBe(false);
  });

  it("clearCachedPartner only affects that user", () => {
    setCachedPartner("a", { partnerId: "x", partnerName: "X", partnerAvatar: null });
    setCachedPartner("b", { partnerId: "y", partnerName: "Y", partnerAvatar: null });
    clearCachedPartner("a");
    expect(getCachedPartner("a")).toBeNull();
    expect(getCachedPartner("b")?.partnerId).toBe("y");
  });
});

// The consent rule lives in the database. There is no live DB in unit tests,
// so this pins the parts of the migration that make it enforceable — if someone
// edits them away, this fails loudly instead of the rule silently lapsing.
describe("20260920150000_partner_unlink_consent.sql (static checks)", () => {
  const sql = readFileSync(
    path.resolve(__dirname, "../../supabase/migrations/20260920150000_partner_unlink_consent.sql"),
    "utf8",
  );

  it("makes unlink_requests read-only for clients", () => {
    expect(sql).toMatch(/GRANT SELECT ON public\.unlink_requests TO authenticated/);
    expect(sql).not.toMatch(/GRANT[^;]*(INSERT|UPDATE|DELETE)[^;]*ON public\.unlink_requests TO authenticated/i);
    expect(sql).not.toMatch(/CREATE POLICY[^;]*ON public\.unlink_requests\s+FOR (INSERT|UPDATE|DELETE)/i);
  });

  it("removes the one-call unilateral unlink from signed-in users", () => {
    expect(sql).toMatch(/REVOKE EXECUTE ON FUNCTION public\.unlink_partner\(uuid\) FROM PUBLIC, anon, authenticated/);
  });

  it("blocks direct client writes to profiles.partner_id", () => {
    expect(sql).toMatch(/BEFORE UPDATE OF partner_id ON public\.profiles/);
    expect(sql).toMatch(/current_user IN \('authenticated', 'anon'\)/);
  });

  it("only lets the receiver answer a request", () => {
    const fn = sql.slice(sql.indexOf("FUNCTION public.respond_unlink"), sql.indexOf("FUNCTION public.cancel_unlink"));
    expect(fn).toMatch(/WHERE id = p_request_id AND partner_id = v_uid/);
  });
});

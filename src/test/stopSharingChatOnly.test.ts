import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const sql = readFileSync("supabase/migrations/20261003140000_stop_sharing_chat_only.sql", "utf8");

describe("stop sharing => chat-only mode (DB enforced)", () => {
  it("blocks new calls for the pair", () => {
    expect(sql).toMatch(/BEFORE INSERT ON public\.call_history/);
    expect(sql).toMatch(/CALLS_DISABLED/);
  });
  it("strips urgent/important flags", () => {
    expect(sql).toMatch(/NEW\.urgent := false/);
    expect(sql).toMatch(/NEW\.important := false/);
  });
  it("hides the stopper's photos: gallery, albums and gallery/memories storage", () => {
    expect(sql).toMatch(/Users can view own gallery[\s\S]*partner_has_stopped_sharing/);
    expect(sql).toMatch(/Couple can view their albums[\s\S]*partner_has_stopped_sharing/);
    expect(sql).toMatch(/'gallery'::text, 'memories'::text\][\s\S]*my_partner_has_stopped_sharing/);
  });
  it("keeps chat-files readable (chat stays available)", () => {
    expect(sql).toMatch(/'chat-files'::text, 'gallery'::text, 'memories'::text/);
    expect(sql).not.toMatch(/NOT \([\s\S]{0,60}'chat-files'/);
  });
  it("never leaves anyone permanently restricted", () => {
    expect(sql).toMatch(/NOT_LINKED/);
    expect(sql).toMatch(/DELETE FROM public\.sharing_state WHERE user_id = v_row\.requester_id/);
  });
});

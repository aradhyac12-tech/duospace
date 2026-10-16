/**
 * Vanish Mode planning rules (src/lib/vanishPlan.ts).
 *
 * The behaviour these lock in:
 *   - turning Vanish Mode off deletes what has been SEEN, both directions;
 *   - a message nobody has seen is NEVER deleted by that (mine are kept and
 *     relabelled, the partner's belong to their own session);
 *   - a "vanish_after_seen" message is deleted only by the person who read it.
 */
import { describe, it, expect } from "vitest";
import { planEndVanish, planSweepSeen, isSpentVanishForViewer, type VanishRow } from "@/lib/vanishPlan";
import { isVanishValue } from "@/lib/chatConstants";

const ME = "me";
const HER = "her";
const row = (id: string, over: Partial<VanishRow> = {}): VanishRow => ({
  id, sender_id: ME, receiver_id: HER, file_url: null, is_read: false, disappear_at: "vanish", ...over,
});

describe("isVanishValue", () => {
  it("accepts both vanish states and nothing else", () => {
    expect(isVanishValue("vanish")).toBe(true);
    expect(isVanishValue("vanish_after_seen")).toBe(true);
    expect(isVanishValue("pending")).toBe(false);
    expect(isVanishValue("2026-09-21T10:00:00.000Z")).toBe(false);
    expect(isVanishValue(null)).toBe(false);
  });
});

describe("planEndVanish", () => {
  it("deletes seen messages in both directions", () => {
    const rows = [
      row("a", { is_read: true }),                                   // I sent, she saw it
      row("b", { sender_id: HER, receiver_id: ME, is_read: true }),  // she sent, I saw it
    ];
    const plan = planEndVanish(rows, ME);
    expect(plan.deleteRows.map(r => r.id)).toEqual(["a", "b"]);
    expect(plan.markAfterSeenIds).toEqual([]);
  });

  it("never deletes a message the partner hasn't seen — keeps and relabels it", () => {
    const plan = planEndVanish([row("unseen", { is_read: false })], ME);
    expect(plan.deleteRows).toEqual([]);
    expect(plan.markAfterSeenIds).toEqual(["unseen"]);
  });

  it("leaves the partner's own unseen vanish messages alone", () => {
    const plan = planEndVanish([row("h", { sender_id: HER, receiver_id: ME, is_read: false })], ME);
    expect(plan.deleteRows).toEqual([]);
    expect(plan.markAfterSeenIds).toEqual([]);
    expect(plan.untouchedIds).toEqual(["h"]);
  });

  it("deletes a kept message only when I'm the one who read it", () => {
    const mineSeenByHer = row("x", { disappear_at: "vanish_after_seen", is_read: true });
    const hersSeenByMe = row("y", { disappear_at: "vanish_after_seen", is_read: true, sender_id: HER, receiver_id: ME });
    const plan = planEndVanish([mineSeenByHer, hersSeenByMe], ME);
    // "x" is still on her screen — she deletes it when she leaves the chat.
    expect(plan.deleteRows.map(r => r.id)).toEqual(["y"]);
  });

  it("carries file_url through so media can be removed with the row", () => {
    const plan = planEndVanish([row("p", { is_read: true, file_url: "https://x/chat-files/me/p.jpg" })], ME);
    expect(plan.deleteRows[0].file_url).toBe("https://x/chat-files/me/p.jpg");
  });

  it("ignores rows that aren't vanish messages", () => {
    const plan = planEndVanish([row("t", { disappear_at: "2026-09-21T10:00:00.000Z", is_read: true })], ME);
    expect(plan.deleteRows).toEqual([]);
    expect(plan.markAfterSeenIds).toEqual([]);
  });
});

describe("planSweepSeen", () => {
  it("only sweeps kept messages that I (the recipient) have read", () => {
    const rows = [
      row("read-by-me", { disappear_at: "vanish_after_seen", is_read: true, sender_id: HER, receiver_id: ME }),
      row("unread", { disappear_at: "vanish_after_seen", is_read: false, sender_id: HER, receiver_id: ME }),
      row("mine", { disappear_at: "vanish_after_seen", is_read: true }),
      row("active-session", { disappear_at: "vanish", is_read: true, sender_id: HER, receiver_id: ME }),
    ];
    expect(planSweepSeen(rows, ME).map(r => r.id)).toEqual(["read-by-me"]);
  });
});

describe("isSpentVanishForViewer", () => {
  const kept = { id: "k", receiver_id: ME, is_read: true, disappear_at: "vanish_after_seen" };
  it("is spent when read on an earlier visit", () => {
    expect(isSpentVanishForViewer(kept, ME, new Set())).toBe(true);
  });
  it("stays visible while it's being read this visit", () => {
    expect(isSpentVanishForViewer(kept, ME, new Set(["k"]))).toBe(false);
  });
  it("is never spent for an unread message, an active-session message, or the sender", () => {
    expect(isSpentVanishForViewer({ ...kept, is_read: false }, ME, new Set())).toBe(false);
    expect(isSpentVanishForViewer({ ...kept, disappear_at: "vanish" }, ME, new Set())).toBe(false);
    expect(isSpentVanishForViewer(kept, HER, new Set())).toBe(false);
  });
});

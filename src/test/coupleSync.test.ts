/**
 * Tests for the pure parts of src/lib/coupleSync.ts — event-type mapping
 * and partner-reaction haptic shapes. Deliberately NOT testing
 * recordCoupleSyncEvent/fetchCoupleSyncEvents/flushCoupleSyncOutbox here —
 * those need a real (or mocked) Supabase client and localStorage/online
 * events; see "remaining limitations" in the implementation report for
 * what that would take.
 */
import { describe, it, expect } from "vitest";
import { partnerReactionHapticSequence, eventTypeToReactionKind } from "@/lib/coupleSync";

describe("eventTypeToReactionKind", () => {
  it("maps every partner_reaction_* type to its plain kind", () => {
    expect(eventTypeToReactionKind("partner_reaction_opened")).toBe("opened");
    expect(eventTypeToReactionKind("partner_reaction_completed")).toBe("completed");
    expect(eventTypeToReactionKind("partner_reaction_heart")).toBe("heart");
  });

  it("returns null for surprise_major_reveal — it has no local felt-pulse of its own yet", () => {
    expect(eventTypeToReactionKind("surprise_major_reveal")).toBeNull();
  });

  it("returns null for surprise_interacted too — it's felt via feelPartnerInteraction, not a PartnerReactionKind", () => {
    expect(eventTypeToReactionKind("surprise_interacted")).toBeNull();
  });
});

describe("partnerReactionHapticSequence", () => {
  it("'opened' is a single tiny confirmation pulse", () => {
    expect(partnerReactionHapticSequence("opened")).toEqual([{ kind: "tick", delayMs: 0 }]);
  });

  it("'completed' is a soft double pulse", () => {
    const seq = partnerReactionHapticSequence("completed");
    expect(seq).toHaveLength(2);
    expect(seq[1].kind).toBe("double");
  });

  it("'heart' is a distinct heartbeat-shaped pulse, not identical to 'completed'", () => {
    const heart = partnerReactionHapticSequence("heart");
    const completed = partnerReactionHapticSequence("completed");
    expect(heart).not.toEqual(completed);
  });

  it("every kind returns a non-empty sequence with only valid delayMs values", () => {
    for (const kind of ["opened", "completed", "heart"] as const) {
      const seq = partnerReactionHapticSequence(kind);
      expect(seq.length).toBeGreaterThan(0);
      for (const step of seq) expect(step.delayMs).toBeGreaterThanOrEqual(0);
    }
  });
});

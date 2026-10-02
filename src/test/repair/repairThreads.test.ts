import { describe, it, expect } from "vitest";
import { deriveRepairThreads, previewRepairShare } from "@/lib/relationship/repair/share";
import type { ShareRow } from "@/lib/relationship/types";

const NOW = Date.parse("2026-09-25T12:00:00Z");
const row = (id: string, payload: Record<string, unknown>, extra: Partial<ShareRow> = {}): ShareRow => ({
  id, ownerId: "x", recipientId: "y", kind: "REPAIR_MESSAGE", itemRef: "s", createdAt: "2026-09-25T10:00:00Z",
  expiresAt: "2026-10-25T00:00:00Z", revokedAt: null, payload: { v: 1, kind: "REPAIR_MESSAGE", ...payload } as never, ...extra,
});
const M1 = "11111111-1111-4111-8111-111111111111", M2 = "22222222-2222-4222-8222-222222222222";

describe("RECEIVED / RESPONDED", () => {
  it("received is RECEIVED until I send a reply that references it", () => {
    const inbox = [row(M1, { message: "I raised my voice. What was happening for you?" })];
    expect(deriveRepairThreads(inbox, [], NOW).receivedMessages[0].state).toBe("RECEIVED");
    expect(deriveRepairThreads(inbox, [row("mine", { message: "Thanks. I was stressed.", inReplyTo: M1 })], NOW).receivedMessages[0].state).toBe("RESPONDED");
  });
  it("a reply to a DIFFERENT message, or a withdrawn reply, doesn't count", () => {
    const inbox = [row(M1, { message: "a" })];
    expect(deriveRepairThreads(inbox, [row("mine", { message: "b", inReplyTo: M2 })], NOW).receivedMessages[0].state).toBe("RECEIVED");
    expect(deriveRepairThreads(inbox, [row("mine", { message: "b", inReplyTo: M1 }, { revokedAt: "2026-09-25T11:00:00Z" })], NOW).receivedMessages[0].state).toBe("RECEIVED");
  });
  it("sender sees the partner's reply to their message", () => {
    const t = deriveRepairThreads([row("r1", { message: "I hear you.", inReplyTo: M1 })], [], NOW);
    expect(t.replyTo(M1)?.message).toBe("I hear you.");
    expect(t.replyTo(M2)).toBeNull();
  });
  it("revoked / expired / non-repair rows are ignored", () => {
    const t = deriveRepairThreads([
      row("a", { message: "x" }, { revokedAt: "2026-09-25T11:00:00Z" }),
      row("b", { message: "x" }, { expiresAt: "2026-09-01T00:00:00Z" }),
      row("c", { message: "x" }, { kind: "INSIGHT" }),
    ], [], NOW);
    expect(t.receivedMessages).toEqual([]);
  });
  it("preview carries only message (+ inReplyTo) and rejects a non-uuid reference", async () => {
    const p = await previewRepairShare("s", "Thanks for telling me.", M1);
    expect(p.payload).toEqual({ v: 1, kind: "REPAIR_MESSAGE", message: "Thanks for telling me.", inReplyTo: M1 });
    await expect(previewRepairShare("s", "hi", "not-a-uuid")).rejects.toBeTruthy();
  });
});

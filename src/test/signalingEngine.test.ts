import { describe, it, expect } from "vitest";
import { isWellFormedSignalingMessage, type SignalingMessage } from "@/lib/signalingEngine/types";

const CALL_ID = "11111111-1111-4111-8111-111111111111";
const RECIPIENT_ID = "22222222-2222-4222-8222-222222222222";

function validMessage(overrides: Partial<SignalingMessage> = {}): SignalingMessage {
  return {
    type: "CALL_OFFER",
    callId: CALL_ID,
    senderId: "user-a", // not UUID-checked — see isWellFormedSignalingMessage's own comment on why
    recipientId: RECIPIENT_ID,
    ts: Date.now(),
    sessionId: "session-1",
    ...overrides,
  };
}

describe("isWellFormedSignalingMessage", () => {
  it("accepts a well-formed message", () => {
    expect(isWellFormedSignalingMessage(validMessage())).toBe(true);
  });

  it("accepts a message with a payload", () => {
    expect(isWellFormedSignalingMessage(validMessage({ payload: { sdp: "..." } }))).toBe(true);
  });

  it.each([
    "type", "callId", "senderId", "recipientId", "sessionId",
  ] as const)("rejects a message missing %s", (field) => {
    const msg = validMessage() as Record<string, unknown>;
    delete msg[field];
    expect(isWellFormedSignalingMessage(msg)).toBe(false);
  });

  it("rejects an empty callId", () => {
    expect(isWellFormedSignalingMessage(validMessage({ callId: "" }))).toBe(false);
  });

  it("rejects a non-UUID callId (REMEDIATION P1-6)", () => {
    expect(isWellFormedSignalingMessage(validMessage({ callId: "call-1" }))).toBe(false);
    expect(isWellFormedSignalingMessage(validMessage({ callId: "not-a-real-uuid-at-all" }))).toBe(false);
  });

  it("rejects a non-UUID recipientId (REMEDIATION P1-6)", () => {
    expect(isWellFormedSignalingMessage(validMessage({ recipientId: "user-b" }))).toBe(false);
  });

  it("rejects an unrecognized event type (REMEDIATION P1-6)", () => {
    expect(isWellFormedSignalingMessage(validMessage({ type: "DELETE_ALL_CALLS" as never }))).toBe(false);
  });

  it("rejects a non-numeric ts", () => {
    const msg = { ...validMessage(), ts: "not-a-number" };
    expect(isWellFormedSignalingMessage(msg)).toBe(false);
  });

  it("rejects an absurdly long sessionId (REMEDIATION P1-6, bounded field length)", () => {
    expect(isWellFormedSignalingMessage(validMessage({ sessionId: "x".repeat(500) }))).toBe(false);
  });

  it("rejects null/undefined/primitives", () => {
    expect(isWellFormedSignalingMessage(null)).toBe(false);
    expect(isWellFormedSignalingMessage(undefined)).toBe(false);
    expect(isWellFormedSignalingMessage("a string")).toBe(false);
    expect(isWellFormedSignalingMessage(42)).toBe(false);
  });

  it("rejects a stale/replayed message the same way — shape is valid but caller must still check sessionId against current generation (see callStateMachine.ts's isCurrentGeneration for the actual staleness guard, which is a separate concern from shape validation)", () => {
    // isWellFormedSignalingMessage only validates SHAPE, not freshness —
    // documenting that boundary explicitly so a future reader doesn't
    // assume this function also rejects stale sessionIds.
    expect(isWellFormedSignalingMessage(validMessage({ sessionId: "an-old-session" }))).toBe(true);
  });
});

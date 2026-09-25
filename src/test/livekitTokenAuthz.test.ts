import { describe, it, expect } from "vitest";
import { authorizeLiveKitToken, livekitRoomNameForCall, type LiveKitCallRow } from "../../supabase/functions/_shared/livekitAuthz";

const CALLER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CALLEE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ID = "11111111-1111-4111-8111-111111111111";
const NOW = 1_000_000;

const row = (over: Partial<LiveKitCallRow> = {}): LiveKitCallRow => ({
  id: ID, caller_id: CALLER, receiver_id: CALLEE, provider: "self_hosted", status: "in_progress",
  claimed_by: null, expires_at: new Date(NOW + 30_000).toISOString(), are_partners: true, declined: false, ...over,
});
const deny = (r: ReturnType<typeof authorizeLiveKitToken>) => (r.ok ? null : { status: r.httpStatus, code: r.code });

describe("authorizeLiveKitToken", () => {
  it("caller may join a still-ringing self-hosted call; the room is DERIVED from the call id", () => {
    const r = authorizeLiveKitToken({ userId: CALLER, call: row(), now: NOW });
    expect(r).toEqual({ ok: true, role: "caller", roomName: `duo-call-${ID}` });
  });

  it("the stored room_name is never used — even a row carrying a hostile one gets the derived room", () => {
    const hostile = { ...row(), room_name: "someone-elses-live-room" } as LiveKitCallRow;
    const r = authorizeLiveKitToken({ userId: CALLER, call: hostile, now: NOW });
    expect(r.ok && r.roomName).toBe(livekitRoomNameForCall(ID));
  });

  it("the receiver gets NO token until it holds the claim", () => {
    expect(deny(authorizeLiveKitToken({ userId: CALLEE, call: row(), now: NOW }))).toEqual({ status: 403, code: "not_claimed" });
    const claimed = authorizeLiveKitToken({ userId: CALLEE, call: row({ claimed_by: CALLEE }), now: NOW });
    expect(claimed).toEqual({ ok: true, role: "receiver", roomName: `duo-call-${ID}` });
  });

  it("caller and receiver are scoped to the SAME room", () => {
    const c = authorizeLiveKitToken({ userId: CALLER, call: row({ claimed_by: CALLEE }), now: NOW });
    const e = authorizeLiveKitToken({ userId: CALLEE, call: row({ claimed_by: CALLEE }), now: NOW });
    expect(c.ok && e.ok && c.roomName === e.roomName).toBe(true);
  });

  it("refuses non-participants, unknown calls, and other providers", () => {
    expect(deny(authorizeLiveKitToken({ userId: OTHER, call: row(), now: NOW }))).toEqual({ status: 403, code: "not_a_participant" });
    expect(deny(authorizeLiveKitToken({ userId: CALLER, call: null, now: NOW }))).toEqual({ status: 404, code: "room_unavailable" });
    expect(deny(authorizeLiveKitToken({ userId: CALLER, call: row({ provider: "daily" }), now: NOW }))).toEqual({ status: 409, code: "wrong_provider" });
    expect(deny(authorizeLiveKitToken({ userId: CALLER, call: row({ provider: null }), now: NOW }))).toEqual({ status: 409, code: "wrong_provider" });
    expect(deny(authorizeLiveKitToken({ userId: CALLER, call: row({ provider: undefined }), now: NOW }))).toEqual({ status: 409, code: "wrong_provider" });
  });

  it("no historical tokens: every non-in_progress status is refused, for both roles", () => {
    for (const status of ["completed", "cancelled", "missed", "failed", "seen"]) {
      expect(deny(authorizeLiveKitToken({ userId: CALLER, call: row({ status, claimed_by: CALLEE }), now: NOW }))).toEqual({ status: 409, code: "room_unavailable" });
      expect(deny(authorizeLiveKitToken({ userId: CALLEE, call: row({ status, claimed_by: CALLEE }), now: NOW }))).toEqual({ status: 409, code: "room_unavailable" });
    }
  });

  it("the caller can't join once the ring window lapsed unclaimed, but a claimed call stays joinable", () => {
    const lapsed = row({ expires_at: new Date(NOW - 1).toISOString() });
    expect(deny(authorizeLiveKitToken({ userId: CALLER, call: lapsed, now: NOW }))).toEqual({ status: 409, code: "ring_expired" });
    expect(authorizeLiveKitToken({ userId: CALLER, call: { ...lapsed, claimed_by: CALLEE }, now: NOW }).ok).toBe(true);
  });

  it("the receiver claim must be THEIR claim", () => {
    expect(deny(authorizeLiveKitToken({ userId: CALLEE, call: row({ claimed_by: OTHER }), now: NOW }))).toEqual({ status: 403, code: "not_claimed" });
  });

  // ── self-hosted-only migration additions ─────────────────────────────
  it("non-partners get no token, even as a participant (fail closed when unknown)", () => {
    expect(deny(authorizeLiveKitToken({ userId: CALLER, call: row({ are_partners: false }), now: NOW }))).toEqual({ status: 403, code: "not_partners" });
    expect(deny(authorizeLiveKitToken({ userId: CALLER, call: row({ are_partners: undefined }), now: NOW }))).toEqual({ status: 403, code: "not_partners" });
  });

  it("a declined call issues no token to either side", () => {
    const declined = row({ declined: true, claimed_by: CALLEE });
    expect(deny(authorizeLiveKitToken({ userId: CALLER, call: declined, now: NOW }))?.code).toBe("room_unavailable");
    expect(deny(authorizeLiveKitToken({ userId: CALLEE, call: declined, now: NOW }))?.code).toBe("room_unavailable");
  });

  it("cancelled / ended / failed / missed calls issue no token", () => {
    for (const status of ["cancelled", "completed", "failed", "missed"]) {
      expect(deny(authorizeLiveKitToken({ userId: CALLER, call: row({ status, claimed_by: CALLEE }), now: NOW }))?.code).toBe("room_unavailable");
    }
  });

  it("an unauthenticated/foreign identity cannot obtain the call's room", () => {
    expect(deny(authorizeLiveKitToken({ userId: OTHER, call: row({ claimed_by: CALLEE }), now: NOW }))?.code).toBe("not_a_participant");
  });
});

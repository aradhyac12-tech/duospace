/**
 * The signaling gateway (infrastructure/signaling) and the app are two
 * deployables with no shared package, so the wire protocol is duplicated
 * by hand. This test imports BOTH copies and fails if they drift — plus
 * the three independent derivations of a call's LiveKit room name.
 */
import { describe, it, expect } from "vitest";
import * as client from "@/lib/signalingEngine/types";
import * as server from "../../infrastructure/signaling/src/types";
import { roomNameForCall as gatewayRoom, SERVER_SENDER_ID as gatewayServerSender } from "../../infrastructure/signaling/src/gateway";
import { livekitRoomNameForCall as edgeRoom } from "../../supabase/functions/_shared/livekitAuthz";

const sorted = (xs: Iterable<string>) => Array.from(xs).sort();

describe("client ↔ gateway protocol parity", () => {
  it("event types", () => {
    expect(sorted(client.SIGNALING_EVENT_TYPES)).toEqual(sorted(server.KNOWN_EVENT_TYPES));
  });
  it("ack statuses, reject reasons and call states", () => {
    expect(sorted(client.ACK_STATUSES)).toEqual(sorted(server.ACK_STATUSES));
    expect(sorted(client.REJECT_REASONS)).toEqual(sorted(server.REJECT_REASONS));
    expect(sorted(client.SERVER_CALL_STATES)).toEqual(sorted(server.SERVER_CALL_STATES));
  });
  it("which refusals are retryable", () => {
    expect(sorted(client.RETRYABLE_REJECT_REASONS)).toEqual(sorted(server.RETRYABLE_REJECT_REASONS));
  });
  it("uuid validation is identical", () => {
    expect(client.UUID_RE.source).toBe(server.UUID_RE.source);
    expect(client.UUID_RE.flags).toBe(server.UUID_RE.flags);
  });
  it("the server-originated sender id", () => {
    expect(client.SERVER_SENDER_ID).toBe(gatewayServerSender);
  });
});

describe("LiveKit room name: one derivation, three implementations", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  it("client == gateway (what CALL_OFFER announces) == livekit-token (what the token is scoped to)", () => {
    expect(client.roomNameForCall(id)).toBe(gatewayRoom(id));
    expect(gatewayRoom(id)).toBe(edgeRoom(id));
    expect(edgeRoom(id)).toBe(`duo-call-${id}`);
  });
});

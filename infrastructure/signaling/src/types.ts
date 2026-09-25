/**
 * Signaling protocol types — kept in sync BY HAND with
 * src/lib/signalingEngine/types.ts on the frontend. This server is a
 * separate deployable (its own package.json/tsconfig, no build-time
 * link to the Vite app), so there is no shared-package import here —
 * duplicated intentionally rather than reached for a monorepo/shared-
 * package restructure. `src/test/signalingProtocolParity.test.ts` (in the
 * Vite app's test suite) reads BOTH files and fails if the event-type
 * list, ack statuses, reject reasons or server call states drift.
 *
 * PHASE 4 (authoritative signaling): this protocol is no longer
 * "relay whatever is well-formed". Every call-control message now gets a
 * typed ACK frame back to its sender (see AckFrame), so a client always
 * knows whether a critical event (offer/accept/reject/cancel/end) was
 * delivered, accepted-but-recipient-offline, or refused (and why).
 */

export type SignalingEventType =
  | "CALL_OFFER"
  | "CALL_RINGING"
  | "CALL_ACCEPTED"
  | "CALL_REJECTED"
  | "CALL_CANCELLED"
  | "CALL_BUSY"
  | "CALL_ENDED"
  | "CALL_SYNC"
  | "PARTICIPANT_READY"
  | "NETWORK_CHANGED"
  | "RECONNECT_REQUEST"
  | "CALL_TIMEOUT";

// REMEDIATION P1-6: explicit allowlist — an unrecognized event type is
// refused, never relayed.
export const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set<SignalingEventType>([
  "CALL_OFFER", "CALL_RINGING", "CALL_ACCEPTED", "CALL_REJECTED",
  "CALL_CANCELLED", "CALL_BUSY", "CALL_ENDED", "CALL_SYNC", "PARTICIPANT_READY",
  "NETWORK_CHANGED", "RECONNECT_REQUEST", "CALL_TIMEOUT",
]);

/** Events that change (or start/end) a call's lifecycle. These are the
 *  "critical" ones: they must be acked, authorized against the call's
 *  real participants, and validated against the call's current state. */
export const CALL_CONTROL_EVENTS: ReadonlySet<string> = new Set<SignalingEventType>([
  "CALL_OFFER", "CALL_RINGING", "CALL_ACCEPTED", "CALL_REJECTED",
  "CALL_CANCELLED", "CALL_BUSY", "CALL_ENDED", "CALL_TIMEOUT",
]);

/** Events relayed between the two participants of a still-live call with
 *  no state change (and a small, size-capped, allowlisted payload). */
export const RELAY_ONLY_EVENTS: ReadonlySet<string> = new Set<SignalingEventType>([
  "PARTICIPANT_READY", "NETWORK_CHANGED", "RECONNECT_REQUEST",
]);

// call_history.id / auth.users.id are both Postgres uuid columns.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SignalingMessage<TPayload = Record<string, unknown>> {
  type: SignalingEventType;
  callId: string;
  senderId: string;
  recipientId: string;
  ts: number;
  sessionId: string;
  /** Client-generated id for ack correlation + idempotent retry. REQUIRED
   *  on every client->server message (isWellFormedMessage rejects a
   *  message without one — there would be nothing to ack). Server->client
   *  forwarded messages carry the originating msgId only for
   *  debugging; receivers never rely on it. */
  msgId?: string;
  payload?: TPayload;
}

/** The server's ephemeral view of a call. Persistent truth stays in
 *  Supabase call_history; this is only what the router needs to reject
 *  stale/invalid transitions. */
export const SERVER_CALL_STATES = [
  "RINGING", "ACCEPTED", "REJECTED", "CANCELLED", "ENDED", "TIMED_OUT", "BUSY",
] as const;
export type ServerCallState = (typeof SERVER_CALL_STATES)[number];

export const TERMINAL_CALL_STATES: ReadonlySet<ServerCallState> = new Set<ServerCallState>([
  "REJECTED", "CANCELLED", "ENDED", "TIMED_OUT", "BUSY",
]);

/** DELIVERED: accepted AND forwarded to the recipient's live socket.
 *  RECIPIENT_OFFLINE: accepted (authorized + state-valid) but the recipient
 *    has no live signaling connection — rely on push/native wake-up (offer)
 *    or the recipient's reconnect-time CALL_SYNC (everything else).
 *  DUPLICATE: same msgId, or an idempotent repeat of an applied event.
 *  REJECTED: refused; `reason` says why. Retry only if the reason is
 *    retryable (RETRYABLE_REJECT_REASONS). */
export const ACK_STATUSES = ["DELIVERED", "RECIPIENT_OFFLINE", "DUPLICATE", "REJECTED"] as const;
export type AckStatus = (typeof ACK_STATUSES)[number];

export const REJECT_REASONS = [
  "MALFORMED", "RATE_LIMITED", "UNKNOWN_CALL", "NOT_A_PARTICIPANT", "RECIPIENT_MISMATCH",
  "SESSION_MISMATCH", "WRONG_PROVIDER", "NOT_PARTNERS", "INVALID_STATE", "CALL_TERMINAL",
  "NOT_CLAIMED", "OFFER_EXPIRED", "SERVER_ONLY_EVENT", "AUTHZ_UNAVAILABLE",
  "STALE_CONNECTION",
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

/** Reasons a client may safely retry (transient server-side conditions).
 *  Everything else is a definitive refusal. */
export const RETRYABLE_REJECT_REASONS: ReadonlySet<RejectReason> = new Set<RejectReason>([
  "RATE_LIMITED", "AUTHZ_UNAVAILABLE",
]);

// ---- server -> client frames ------------------------------------------------

export interface AckFrame {
  kind: "ack";
  msgId: string;
  callId: string;
  type: SignalingEventType | "UNKNOWN";
  status: AckStatus;
  reason?: RejectReason;
  /** Server's view of the call AFTER handling this message (lets a client
   *  that just got INVALID_STATE see e.g. "ACCEPTED" and convert a
   *  cancel into an end). */
  state?: ServerCallState;
  sessionId?: string;
}

export interface StateFrame {
  kind: "state";
  callId: string;
  sessionId: string;
  state: ServerCallState | "UNKNOWN";
  /** Present only for terminal states derived from persistent state. */
  reason?: string;
}

/** Sent once per connection AFTER authentication + session registration:
 *  "this socket is authenticated and usable". Clients must not treat a
 *  bare WebSocket `open` as READY. */
export interface ReadyFrame {
  kind: "ready";
  userId: string;
  serverTime: number;
}

export interface PingFrame {
  kind: "ping";
  ts: number;
}

export type ServerFrame = AckFrame | StateFrame | ReadyFrame | PingFrame;

export const MAX_MSG_ID_LENGTH = 64;

export function isWellFormedMessage(msg: unknown): msg is SignalingMessage {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  return (
    typeof m.type === "string" && KNOWN_EVENT_TYPES.has(m.type) &&
    typeof m.callId === "string" && UUID_RE.test(m.callId) &&
    typeof m.recipientId === "string" && UUID_RE.test(m.recipientId) &&
    typeof m.sessionId === "string" && m.sessionId.length > 0 && m.sessionId.length <= 128 &&
    typeof m.msgId === "string" && m.msgId.length > 0 && m.msgId.length <= MAX_MSG_ID_LENGTH
  );
  // senderId / ts are deliberately NOT validated: the server overwrites
  // both from its own authenticated view (gateway.ts), so a forged or
  // missing client value is irrelevant, not a validation failure.
}

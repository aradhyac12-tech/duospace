/**
 * Signaling protocol + transport contracts (client side).
 *
 * PHASE 4 — AUTHORITATIVE SIGNALING. For SELF-HOSTED calls this WebSocket
 * layer is the call-control transport: offer (ring), accept, reject,
 * cancel, end and ring-timeout travel over it and are ACKED by the server
 * (see AckFrame). Supabase call_history remains persistence/history/
 * authorization data; Supabase Realtime is no longer awaited by any
 * self-hosted control path (it survives only as a labelled recovery path
 * for a recipient whose socket was down — see IncomingCallOverlay.tsx).
 * The call engine is untouched and never touches this layer.
 *
 * This file mirrors infrastructure/signaling/src/types.ts BY HAND (two
 * separate deployables, no shared package). src/test/
 * signalingProtocolParity.test.ts imports both and fails on drift.
 */

export const SIGNALING_EVENT_TYPES = [
  "CALL_OFFER", "CALL_RINGING", "CALL_ACCEPTED", "CALL_REJECTED", "CALL_CANCELLED",
  "CALL_BUSY", "CALL_ENDED", "CALL_SYNC", "PARTICIPANT_READY", "NETWORK_CHANGED",
  "RECONNECT_REQUEST", "CALL_TIMEOUT",
] as const;
export type SignalingEventType = (typeof SIGNALING_EVENT_TYPES)[number];

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set<string>(SIGNALING_EVENT_TYPES);
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Sender id the server stamps on events it originates itself (ring
 *  timeout). No user id can equal it; clients can never SEND CALL_TIMEOUT. */
export const SERVER_SENDER_ID = "server";

/** LiveKit room for a call — must equal gateway.ts roomNameForCall() and
 *  supabase/functions/_shared/livekitAuthz.ts livekitRoomNameForCall(). */
export function roomNameForCall(callId: string): string {
  return `duo-call-${callId}`;
}

export const ACK_STATUSES = ["DELIVERED", "RECIPIENT_OFFLINE", "DUPLICATE", "REJECTED"] as const;
export type AckStatus = (typeof ACK_STATUSES)[number];

export const REJECT_REASONS = [
  "MALFORMED", "RATE_LIMITED", "UNKNOWN_CALL", "NOT_A_PARTICIPANT", "RECIPIENT_MISMATCH",
  "SESSION_MISMATCH", "WRONG_PROVIDER", "NOT_PARTNERS", "INVALID_STATE", "CALL_TERMINAL",
  "NOT_CLAIMED", "OFFER_EXPIRED", "SERVER_ONLY_EVENT", "AUTHZ_UNAVAILABLE",
  "STALE_CONNECTION",
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

/** Transient server-side conditions a client may retry under the SAME msgId. */
export const RETRYABLE_REJECT_REASONS: ReadonlySet<RejectReason> = new Set<RejectReason>([
  "RATE_LIMITED", "AUTHZ_UNAVAILABLE",
]);

export const SERVER_CALL_STATES = [
  "RINGING", "ACCEPTED", "REJECTED", "CANCELLED", "ENDED", "TIMED_OUT", "BUSY",
] as const;
export type ServerCallState = (typeof SERVER_CALL_STATES)[number];

/**
 * A signaling message. `senderId` is what the SERVER stamps from the
 * authenticated connection (the client's own value is discarded there);
 * `sessionId` is the call's authoritative DB-generated session id
 * (call_history.session_id), not a client invention.
 */
export interface SignalingMessage<TPayload = Record<string, unknown>> {
  type: SignalingEventType;
  callId: string;
  senderId: string;
  recipientId: string;
  ts: number;
  sessionId: string;
  msgId?: string;
  payload?: TPayload;
}

export type OutboundSignal = Omit<SignalingMessage, "senderId" | "ts"> & { msgId: string };

// ---- server -> client frames --------------------------------------------------

export interface AckFrame {
  kind: "ack";
  msgId: string;
  callId: string;
  type: SignalingEventType | "UNKNOWN";
  status: AckStatus;
  reason?: RejectReason;
  state?: ServerCallState;
  sessionId?: string;
}
export interface StateFrame {
  kind: "state";
  callId: string;
  sessionId: string;
  state: ServerCallState | "UNKNOWN";
}
export interface ReadyFrame { kind: "ready"; userId: string; serverTime: number }
export interface PingFrame { kind: "ping"; ts: number }
export type ServerFrame = AckFrame | StateFrame | ReadyFrame | PingFrame;

// ---- transport ---------------------------------------------------------------

export type SignalingConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

/** What a transport reports upward. `ready` fires on EVERY (re)connect once
 *  the server has authenticated + registered the socket; `reconnected` is
 *  true for all but the first. */
export type TransportEvent =
  | { kind: "signal"; message: SignalingMessage }
  | { kind: "ack"; frame: AckFrame }
  | { kind: "state"; frame: StateFrame }
  | { kind: "ready"; reconnected: boolean }
  | { kind: "connection"; state: SignalingConnectionState };

export interface SignalingTransport {
  /** Resolves when the socket is READY (authenticated + registered —
   *  not merely open). Rejects after the connect timeout; background
   *  retries continue until disconnect(). */
  connect(timeoutMs?: number): Promise<void>;
  disconnect(): void;
  isReady(): boolean;
  getConnectionState(): SignalingConnectionState;
  /** Writes one frame if (and only if) the socket is ready. Returns
   *  whether it was actually written — never queues silently. */
  sendFrame(message: OutboundSignal): boolean;
  subscribe(handler: (event: TransportEvent) => void): () => void;
  /** Skip the reconnect backoff and try now (app resumed / network back). */
  nudge(): void;
  /** Network changed: replace a possibly half-open socket, then nudge. */
  checkLiveness?(maxSilenceMs?: number): void;
}

// ---- results -----------------------------------------------------------------

/**
 * The outcome of one call-control send. Critical events are never
 * fire-and-forget: every one resolves to exactly one of these.
 *
 *  DELIVERED          server accepted it and wrote it to the peer's socket
 *  RECIPIENT_OFFLINE  server accepted it; the peer has no live socket
 *                     (offer → push/native wake-up is the delivery path)
 *  DUPLICATE          idempotent repeat; already applied
 *  REJECTED           server refused it (`reason`); definitive unless retryable
 *  QUEUED             not deliverable right now; a bounded retry is running
 *  TIMEOUT            written, never acked, retries exhausted
 *  FAILED             could not be sent at all
 */
export type SignalingResult =
  | { status: "DELIVERED" | "RECIPIENT_OFFLINE" | "DUPLICATE"; msgId: string; state?: ServerCallState; attempts: number; latencyMs: number }
  | { status: "REJECTED"; msgId: string; reason: RejectReason; state?: ServerCallState; attempts: number; latencyMs: number }
  | { status: "QUEUED"; msgId: string }
  | { status: "TIMEOUT"; msgId: string; attempts: number }
  | { status: "FAILED"; msgId: string; reason: "NOT_CONFIGURED" | "NOT_READY" | "NO_SESSION" | "DISPOSED"; attempts: number };

/** A plain interface (not a `ready: true | false` discriminated union):
 *  this project compiles with strictNullChecks off, where TypeScript does
 *  not narrow on a boolean discriminant. `reason` is set iff ready is false. */
export type ReadyFailureReason = "NOT_CONFIGURED" | "NO_USER" | "CONNECT_TIMEOUT" | "DISPOSED";
export interface ReadyResult {
  ready: boolean;
  waitedMs?: number;
  reason?: ReadyFailureReason;
}

/** The server has authorized+recorded the event (it may still be RECIPIENT_OFFLINE). */
export function isServerAccepted(r: SignalingResult): r is Extract<SignalingResult, { status: "DELIVERED" | "RECIPIENT_OFFLINE" | "DUPLICATE" }> {
  return r.status === "DELIVERED" || r.status === "RECIPIENT_OFFLINE" || r.status === "DUPLICATE";
}

/** Shape validation for an INBOUND (server-forwarded) message. Defense in
 *  depth — the server is the authority; this does not prove authenticity. */
export function isWellFormedSignalingMessage(msg: unknown): msg is SignalingMessage {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  return (
    typeof m.type === "string" && KNOWN_EVENT_TYPES.has(m.type) &&
    typeof m.callId === "string" && UUID_RE.test(m.callId) &&
    typeof m.senderId === "string" && m.senderId.length > 0 &&
    typeof m.recipientId === "string" && UUID_RE.test(m.recipientId) &&
    typeof m.ts === "number" &&
    typeof m.sessionId === "string" && m.sessionId.length > 0 && m.sessionId.length <= 128
  );
}

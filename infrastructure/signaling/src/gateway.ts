/**
 * gateway — the DuoSpace Call Gateway's routing + authorization core,
 * independent of any socket library (server.ts adapts `ws` to it).
 *
 * PHASE 4 (authoritative signaling). Before this, the server only
 * authenticated the WebSocket and then relayed any well-formed message to
 * whichever user id the message NAMED — no check that the sender was in
 * the call, that the recipient was the other party, that the call was in
 * a state that permitted the event, or that the session was current.
 *
 * For EVERY call-control message this now does, in order:
 *
 *   1. size cap → per-user rate limit → shape validation
 *   2. idempotency (same msgId = same answer, never re-applied)
 *   3. resolve the call's authoritative facts (registry, else Supabase via
 *      CallAuthorizer) — never the client's claims
 *   4. sender must be the call's caller or receiver
 *   5. recipientId must be the OTHER participant
 *   6. sessionId must equal the call's authoritative sessionId
 *   7. per-event rules: OFFER needs provider=self_hosted + current
 *      partnership + a still-ringing unclaimed call; ACCEPTED needs the
 *      sender to actually hold the claim (claim_call) in Supabase;
 *      everything is validated against the ephemeral state machine
 *      (callRegistry.ts) so CALL_ACCEPTED-after-terminal,
 *      CALL_CANCELLED-after-accepted, CALL_ENDED-from-a-stranger, etc.
 *      are refused
 *   8. forward a SERVER-BUILT message (server-stamped senderId/ts and,
 *      for control events, a server-built payload — the client's payload
 *      is never relayed for those)
 *   9. ACK the sender with what actually happened: DELIVERED,
 *      RECIPIENT_OFFLINE, DUPLICATE, or REJECTED+reason.
 *
 * Persistent truth remains Supabase call_history; the registry here is
 * ephemeral routing state only and is safely rebuilt from Supabase after
 * a restart (an unknown callId is re-resolved on its next message).
 *
 * Deliberately NOT here: any push-notification delivery. An offline
 * recipient is reported to the sender as RECIPIENT_OFFLINE; reaching a
 * backgrounded/killed device remains FCM/APNs/native call UI's job.
 */
import { AuthorizerUnavailableError, initialStateFromFacts, type CallAuthorizer, type CallFacts } from "./authorizer.js";
import {
  CallRegistry, counterpartOf, evaluateTransition, roleOf, type CallEntry,
} from "./callRegistry.js";
import { SessionRegistry, type GatewayConnection } from "./session.js";
import {
  CALL_CONTROL_EVENTS, RELAY_ONLY_EVENTS, TERMINAL_CALL_STATES, isWellFormedMessage,
  type AckFrame, type AckStatus, type PingFrame, type ReadyFrame, type RejectReason,
  type ServerCallState, type SignalingEventType, type SignalingMessage, type StateFrame,
} from "./types.js";

/** Sender id stamped on server-originated events (CALL_TIMEOUT). No user
 *  id can equal this (user ids are UUIDs), and clients are not allowed to
 *  SEND CALL_TIMEOUT at all (SERVER_ONLY_EVENT). */
export const SERVER_SENDER_ID = "server";

/** LiveKit room name for a call. Identical (by construction — see
 *  src/test/signalingProtocolParity.test.ts) to the derivation the
 *  `livekit-token` edge function uses, so the room a callee is told about
 *  in CALL_OFFER is exactly the room its token will be scoped to. */
export function roomNameForCall(callId: string): string {
  return `duo-call-${callId}`;
}

export interface RateLimiterLike {
  check(key: string): boolean;
}

export interface GatewayOptions {
  authorizer: CallAuthorizer;
  messageLimiter: RateLimiterLike;
  now?: () => number;
  /** How long an offer rings server-side. Mirrors call_history's own 40s
   *  expires_at window (set_call_expiry()); never extends past it. */
  ringTtlMs?: number;
  maxMessageBytes?: number;
  registry?: CallRegistry;
  sessions?: SessionRegistry;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

const DEFAULT_RING_TTL_MS = 40_000;
const DEFAULT_MAX_MESSAGE_BYTES = 8 * 1024;
const IDEMPOTENCY_TTL_MS = 60_000;
const IDEMPOTENCY_MAX = 4_000;
const RELAY_PAYLOAD_MAX_KEYS = 8;
const RELAY_PAYLOAD_MAX_STRING = 128;
const REASON_RE = /^[a-z0-9_]{1,32}$/i;

const short = (id: string) => id.slice(0, 8);

export class SignalingGateway {
  readonly registry: CallRegistry;
  readonly sessions: SessionRegistry;
  private readonly authorizer: CallAuthorizer;
  private readonly limiter: RateLimiterLike;
  private readonly now: () => number;
  private readonly ringTtlMs: number;
  private readonly maxBytes: number;
  private readonly log: (event: string, data?: Record<string, unknown>) => void;

  private readonly answered = new Map<string, { ack: AckFrame; at: number }>();
  private readonly inflight = new Map<string, Promise<AckFrame>>();
  private readonly resolving = new Map<string, Promise<CallFacts | null>>();
  private readonly counters: Record<string, number> = {};

  constructor(opts: GatewayOptions) {
    this.authorizer = opts.authorizer;
    this.limiter = opts.messageLimiter;
    this.now = opts.now ?? Date.now;
    this.ringTtlMs = opts.ringTtlMs ?? DEFAULT_RING_TTL_MS;
    this.maxBytes = opts.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    this.registry = opts.registry ?? new CallRegistry();
    this.sessions = opts.sessions ?? new SessionRegistry();
    this.log = opts.log ?? (() => undefined);
  }

  // ---- connection lifecycle ------------------------------------------------

  /** Called after the socket is authenticated (ticket verified). Registers
   *  the session, tells the client it is READY, and replays any offer that
   *  arrived while this user had no live socket and is still ringing. */
  connect(userId: string, conn: GatewayConnection): void {
    this.sessions.register(userId, conn);
    this.sendFrame(conn, { kind: "ready", userId, serverTime: this.now() } satisfies ReadyFrame);
    const now = this.now();
    for (const entry of this.registry.pendingOffersFor(userId, now)) {
      if (!entry.pendingOffer) continue;
      const replay: SignalingMessage = {
        ...entry.pendingOffer,
        ts: now,
        payload: { ...(entry.pendingOffer.payload ?? {}), ringTtlMs: Math.max(0, entry.ringExpiresAt - now), replayed: true },
      };
      if (this.sendFrame(conn, replay)) {
        entry.offerDelivered = true;
        this.count("offer_replayed_on_connect");
      }
    }
  }

  disconnect(userId: string, conn: GatewayConnection): void {
    this.sessions.unregister(userId, conn);
  }

  /** Periodic: ring timeouts (both parties told), stale-entry eviction,
   *  idempotency-cache pruning. */
  sweep(): void {
    const now = this.now();
    for (const entry of this.registry.sweep(now)) {
      this.count("ring_timeout");
      for (const target of [entry.callerId, entry.receiverId]) {
        this.forward(target, {
          type: "CALL_TIMEOUT", callId: entry.callId, senderId: SERVER_SENDER_ID, recipientId: target,
          ts: now, sessionId: entry.sessionId,
        });
      }
    }
    for (const [k, v] of this.answered) if (now - v.at > IDEMPOTENCY_TTL_MS) this.answered.delete(k);
  }

  /** Application-level liveness probe — lets a client detect a half-open
   *  socket (browsers expose no protocol-level ping). */
  heartbeat(): void {
    const frame: PingFrame = { kind: "ping", ts: this.now() };
    for (const c of this.sessions.connections()) this.sendFrame(c, frame);
  }

  stats(): { sessions: number; calls: number; counters: Record<string, number> } {
    return { sessions: this.sessions.size(), calls: this.registry.size(), counters: { ...this.counters } };
  }

  // ---- inbound -------------------------------------------------------------

  async handleRaw(userId: string, conn: GatewayConnection, raw: string | Uint8Array): Promise<void> {
    const size = typeof raw === "string" ? raw.length : raw.byteLength;
    if (size > this.maxBytes) { this.count("dropped_oversize"); return; } // can't trust, can't ack

    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      this.count("dropped_unparseable");
      return;
    }

    // STALE-SOCKET GUARD: once a newer socket for this user has registered
    // (SessionRegistry.register closes the old one with 4000), anything
    // still arriving on the OLD socket — in flight before its close
    // completed — must never control a call.
    if (this.sessions.getConnection(userId) !== conn) {
      this.count("stale_connection");
      this.ackIfIdentifiable(conn, parsed, "STALE_CONNECTION");
      return;
    }

    if (!this.limiter.check(userId)) {
      this.count("rate_limited");
      this.ackIfIdentifiable(conn, parsed, "RATE_LIMITED");
      return;
    }
    if (!isWellFormedMessage(parsed)) {
      this.count("malformed");
      this.ackIfIdentifiable(conn, parsed, "MALFORMED");
      return;
    }

    // Client-claimed senderId/ts are discarded; identity is the
    // authenticated connection's.
    const msg: SignalingMessage = { ...parsed, senderId: userId, ts: this.now() };
    const key = `${userId}:${msg.msgId}`;

    const previous = this.answered.get(key);
    if (previous) { this.sendFrame(conn, previous.ack); return; }
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.process(userId, msg).then((ack) => {
        this.remember(key, ack);
        return ack;
      }).finally(() => { this.inflight.delete(key); });
      this.inflight.set(key, pending);
    }
    const ack = await pending;
    this.sendFrame(conn, ack);
  }

  // ---- core ----------------------------------------------------------------

  private async process(userId: string, msg: SignalingMessage): Promise<AckFrame> {
    const base = { kind: "ack" as const, msgId: msg.msgId as string, callId: msg.callId, type: msg.type };
    const refuse = (reason: RejectReason, entry?: CallEntry): AckFrame => {
      this.count(`rejected_${reason}`);
      this.log("signal_rejected", { type: msg.type, reason, call: short(msg.callId), sender: short(userId) });
      return { ...base, status: "REJECTED", reason, state: entry?.state, sessionId: entry ? entry.sessionId : undefined };
    };
    const accept = (status: AckStatus, entry: CallEntry): AckFrame => {
      this.count(`acked_${status}`);
      // Every accepted control message (CALL_OFFER / CALL_ACCEPTED /
      // CALL_REJECTED / CALL_CANCELLED / CALL_ENDED …) is logged with ids only
      // (truncated) — previously only rejections were, so a deployed call
      // could not be traced from server logs.
      this.log("signal_accepted", { type: msg.type, status, state: entry.state, call: short(msg.callId), session: short(entry.sessionId), sender: short(userId) });
      return { ...base, status, state: entry.state, sessionId: entry.sessionId };
    };

    if (msg.type === "CALL_TIMEOUT") return refuse("SERVER_ONLY_EVENT");

    // 3. authoritative facts / registry entry
    let entry = this.registry.get(msg.callId);
    if (!entry) {
      let facts: CallFacts | null;
      try {
        facts = await this.resolveFacts(msg.callId);
      } catch {
        return refuse("AUTHZ_UNAVAILABLE");
      }
      // A concurrent message may have created the entry while we awaited.
      entry = this.registry.get(msg.callId);
      if (!entry) {
        if (!facts) return refuse("UNKNOWN_CALL");
        if (facts.provider !== "self_hosted") return refuse("WRONG_PROVIDER");
        entry = this.entryFromFacts(facts, msg.type === "CALL_OFFER");
        this.registry.put(entry);
      }
    }

    // 4-6. participant / counterpart / session
    const role = roleOf(entry, userId);
    // No entry passed: a stranger learns nothing about the call's state/session.
    if (!role) return refuse("NOT_A_PARTICIPANT");
    const counterpart = counterpartOf(entry, userId) as string;
    if (msg.recipientId !== counterpart) return refuse("RECIPIENT_MISMATCH", entry);
    if (msg.sessionId !== entry.sessionId) return refuse("SESSION_MISMATCH", entry);

    // 7. per-event rules
    if (msg.type === "CALL_SYNC") return this.handleSync(userId, entry, accept);
    if (msg.type === "CALL_OFFER") return this.handleOffer(userId, msg, entry, accept, refuse);

    if (RELAY_ONLY_EVENTS.has(msg.type)) {
      if (TERMINAL_CALL_STATES.has(entry.state)) return refuse("CALL_TERMINAL", entry);
      const delivered = this.forward(counterpart, this.serverMessage(msg, entry, counterpart, sanitizeRelayPayload(msg.payload)));
      return accept(delivered ? "DELIVERED" : "RECIPIENT_OFFLINE", entry);
    }

    if (msg.type === "CALL_RINGING") {
      if (role !== "receiver") return refuse("INVALID_STATE", entry);
      if (entry.state !== "RINGING") return refuse(TERMINAL_CALL_STATES.has(entry.state) ? "CALL_TERMINAL" : "INVALID_STATE", entry);
      const delivered = this.forward(counterpart, this.serverMessage(msg, entry, counterpart));
      return accept(delivered ? "DELIVERED" : "RECIPIENT_OFFLINE", entry);
    }

    if (!CALL_CONTROL_EVENTS.has(msg.type)) return refuse("INVALID_STATE", entry);

    const decision = evaluateTransition(entry, msg.type, userId);
    if (!decision.ok) return refuse(decision.reason, entry);
    if (!decision.changed) return accept("DUPLICATE", entry);

    if (msg.type === "CALL_ACCEPTED") {
      // The accepter must actually hold the claim in Supabase — a WebSocket
      // accept alone never wins a call (claim_call is the atomic CAS).
      let facts: CallFacts | null;
      try {
        facts = await this.authorizer.getCallFacts(entry.callId);
      } catch {
        return refuse("AUTHZ_UNAVAILABLE", entry);
      }
      if (!facts) return refuse("UNKNOWN_CALL", entry);
      // Re-evaluate: the entry may have changed while we awaited.
      const recheck = evaluateTransition(entry, msg.type, userId);
      if (!recheck.ok) return refuse(recheck.reason, entry);
      if (!recheck.changed) return accept("DUPLICATE", entry);
      if (facts.status !== "in_progress") return refuse("CALL_TERMINAL", entry);
      if (facts.claimedBy !== userId) return refuse("NOT_CLAIMED", entry);
    }

    this.registry.transition(entry, decision.next, this.now());
    const payload = sanitizeReasonPayload(msg.payload);
    const delivered = this.forward(counterpart, this.serverMessage(msg, entry, counterpart, payload));
    return accept(delivered ? "DELIVERED" : "RECIPIENT_OFFLINE", entry);
  }

  private async handleOffer(
    userId: string,
    msg: SignalingMessage,
    entry: CallEntry,
    accept: (s: AckStatus, e: CallEntry) => AckFrame,
    refuse: (r: RejectReason, e?: CallEntry) => AckFrame,
  ): Promise<AckFrame> {
    if (roleOf(entry, userId) !== "caller") return refuse("INVALID_STATE", entry);
    if (TERMINAL_CALL_STATES.has(entry.state)) return refuse("CALL_TERMINAL", entry);
    if (entry.state !== "RINGING") return refuse("INVALID_STATE", entry);

    if (!entry.partnersVerified) {
      // Entry was rebuilt from a non-OFFER message: re-check the
      // relationship (and that the call is still genuinely unclaimed).
      let facts: CallFacts | null;
      try { facts = await this.authorizer.getCallFacts(entry.callId); } catch { return refuse("AUTHZ_UNAVAILABLE", entry); }
      if (!facts) return refuse("UNKNOWN_CALL", entry);
      if (!facts.arePartners) return refuse("NOT_PARTNERS", entry);
      if (facts.status !== "in_progress" || facts.claimedBy) return refuse("CALL_TERMINAL", entry);
      entry.partnersVerified = true;
    }

    const now = this.now();
    if (entry.ringExpiresAt <= now) {
      this.registry.transition(entry, "TIMED_OUT", now);
      return refuse("OFFER_EXPIRED", entry);
    }
    if (entry.offerDelivered) return accept("DUPLICATE", entry);

    const offer: SignalingMessage = {
      type: "CALL_OFFER", callId: entry.callId, senderId: entry.callerId, recipientId: entry.receiverId,
      ts: now, sessionId: entry.sessionId,
      payload: { callType: entry.callType, roomName: roomNameForCall(entry.callId), ringTtlMs: entry.ringExpiresAt - now },
    };
    entry.pendingOffer = offer;
    const delivered = this.forward(entry.receiverId, offer);
    if (delivered) entry.offerDelivered = true;
    return accept(delivered ? "DELIVERED" : "RECIPIENT_OFFLINE", entry);
  }

  private handleSync(
    userId: string,
    entry: CallEntry,
    accept: (s: AckStatus, e: CallEntry) => AckFrame,
  ): AckFrame {
    const conn = this.sessions.getConnection(userId);
    if (conn) {
      this.sendFrame(conn, {
        kind: "state", callId: entry.callId, sessionId: entry.sessionId, state: entry.state,
      } satisfies StateFrame);
    }
    return accept("DELIVERED", entry);
  }

  // ---- helpers -------------------------------------------------------------

  private resolveFacts(callId: string): Promise<CallFacts | null> {
    let p = this.resolving.get(callId);
    if (!p) {
      p = this.authorizer.getCallFacts(callId).finally(() => { this.resolving.delete(callId); });
      this.resolving.set(callId, p);
    }
    return p;
  }

  private entryFromFacts(f: CallFacts, forOffer: boolean): CallEntry {
    const now = this.now();
    const state: ServerCallState = initialStateFromFacts(f, now);
    const ttlEnd = now + this.ringTtlMs;
    return {
      callId: f.callId, sessionId: f.sessionId, callerId: f.callerId, receiverId: f.receiverId,
      callType: f.callType, state,
      ringExpiresAt: f.expiresAt === null ? ttlEnd : Math.min(ttlEnd, f.expiresAt),
      updatedAt: now, offerDelivered: false, partnersVerified: forOffer && f.arePartners, pendingOffer: null,
    };
  }

  private serverMessage(
    msg: SignalingMessage, entry: CallEntry, recipientId: string, payload?: Record<string, unknown>,
  ): SignalingMessage {
    const out: SignalingMessage = {
      type: msg.type, callId: entry.callId, senderId: msg.senderId, recipientId,
      ts: this.now(), sessionId: entry.sessionId,
    };
    if (payload && Object.keys(payload).length > 0) out.payload = payload;
    return out;
  }

  private forward(recipientId: string, message: SignalingMessage): boolean {
    const conn = this.sessions.getConnection(recipientId);
    if (!conn || !conn.isOpen()) return false;
    return this.sendFrame(conn, message);
  }

  private sendFrame(conn: GatewayConnection, frame: unknown): boolean {
    try {
      conn.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  private ackIfIdentifiable(conn: GatewayConnection, parsed: unknown, reason: RejectReason): void {
    if (!parsed || typeof parsed !== "object") return;
    const m = parsed as Record<string, unknown>;
    if (typeof m.msgId !== "string" || m.msgId.length === 0 || m.msgId.length > 64) return;
    const ack: AckFrame = {
      kind: "ack", msgId: m.msgId,
      callId: typeof m.callId === "string" ? m.callId : "",
      type: typeof m.type === "string" ? (m.type as SignalingEventType) : "UNKNOWN",
      status: "REJECTED", reason,
    };
    this.sendFrame(conn, ack);
  }

  private remember(key: string, ack: AckFrame): void {
    // Transient refusals must stay retryable under the SAME msgId, so
    // they are never cached as "the answer".
    if (ack.status === "REJECTED" && (ack.reason === "AUTHZ_UNAVAILABLE" || ack.reason === "RATE_LIMITED")) return;
    if (this.answered.size >= IDEMPOTENCY_MAX) {
      const oldest = this.answered.keys().next().value as string | undefined;
      if (oldest) this.answered.delete(oldest);
    }
    this.answered.set(key, { ack, at: this.now() });
  }

  private count(name: string): void {
    this.counters[name] = (this.counters[name] ?? 0) + 1;
  }
}

/** Relay-only events carry a tiny, flat, primitive payload — nothing else. */
export function sanitizeRelayPayload(payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (n >= RELAY_PAYLOAD_MAX_KEYS) break;
    if (!/^[a-z][a-zA-Z0-9_]{0,31}$/.test(k)) continue;
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "string" && v.length <= RELAY_PAYLOAD_MAX_STRING) out[k] = v;
    else continue;
    n += 1;
  }
  return out;
}

/** Control events may carry ONE optional descriptive `reason` token
 *  (e.g. "timeout" vs "user" on a reject) — nothing else is relayed. */
export function sanitizeReasonPayload(payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const reason = (payload as Record<string, unknown>).reason;
  if (typeof reason === "string" && REASON_RE.test(reason)) return { reason };
  return undefined;
}

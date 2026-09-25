/**
 * CallSignalingClient — the call-control layer on top of a
 * SignalingTransport. Framework-free (no React) so its behavior is unit-
 * and integration-testable; callSignalingBridge.ts is the thin React
 * wrapper.
 *
 * WHAT CHANGED IN PHASE 4: the previous bridge was "send if connected,
 * otherwise silently continue". That is acceptable for optional
 * telemetry and unacceptable for CALL_OFFER / ACCEPTED / REJECTED /
 * CANCELLED / ENDED. This client:
 *
 *  - gives every critical send a typed SignalingResult (delivered /
 *    recipient offline / duplicate / rejected+reason / queued / timeout /
 *    failed) — nothing is dropped without the caller learning it;
 *  - retries under the SAME msgId (the gateway is idempotent per msgId),
 *    waits for reconnect, and has a bounded deadline;
 *  - exposes ensureReady(): "self-hosted call READY" means authenticated
 *    + registered by the gateway, and a failure is reported, never
 *    papered over with a Supabase fallback;
 *  - tracks a local session per call (callId + sessionId + peer + role +
 *    state) and uses it to (a) address messages, (b) refuse to send an
 *    event that is illegal for the call's state, and (c) discard stale,
 *    forged, duplicate or wrong-session INBOUND events before any UI
 *    sees them (an old CALL_ACCEPTED/CANCELLED/ENDED can never affect a
 *    newer call);
 *  - resynchronizes after a reconnect with CALL_SYNC and synthesizes any
 *    terminal event that was missed while the socket was down — without
 *    creating a new logical call and without touching media.
 *
 * Supabase remains the persistent truth. Callers do the authoritative DB
 * transition (claim_call / decline_call / cancel_call / the end update)
 * and then signal; this client never writes the database.
 */
import { realClock, newMessageId, type Clock } from "./clock";
import {
  RETRYABLE_REJECT_REASONS, SERVER_SENDER_ID, isServerAccepted,
  type AckFrame, type OutboundSignal, type ReadyResult, type ServerCallState,
  type SignalingConnectionState, type SignalingEventType, type SignalingMessage,
  type SignalingResult, type SignalingTransport, type TransportEvent,
} from "./types";

export type LocalCallState = "RINGING" | "ACCEPTED" | "REJECTED" | "CANCELLED" | "ENDED" | "TIMED_OUT" | "BUSY";
const TERMINAL: ReadonlySet<LocalCallState> = new Set(["REJECTED", "CANCELLED", "ENDED", "TIMED_OUT", "BUSY"]);

export interface CallSession {
  callId: string;
  sessionId: string;
  peerId: string;
  role: "caller" | "receiver";
  state: LocalCallState;
  callType?: "voice" | "video";
  updatedAt: number;
}

export interface CallSignalingClientOptions {
  userId: string | null | undefined;
  /** False (VITE_SIGNALING_URL unset) = self-hosted signaling is not
   *  available at all; every operation reports NOT_CONFIGURED. */
  configured: boolean;
  createTransport: () => SignalingTransport;
  clock?: Clock;
  newId?: () => string;
  ackTimeoutMs?: number;
  maxAttempts?: number;
  /** Deadline for OFFER (caller is waiting on it). */
  offerDeadlineMs?: number;
  /** Deadline for accept/reject/cancel/end (background retry window). */
  controlDeadlineMs?: number;
  onTelemetry?: (event: string, data?: Record<string, unknown>) => void;
}

export interface SendOptions {
  deadlineMs?: number;
  /** If the transport isn't ready right now, resolve QUEUED immediately
   *  and keep retrying in the background; the final outcome is reported
   *  to `onSettled`. Used for UI-driven accept/reject/cancel/end. */
  returnQueued?: boolean;
  onSettled?: (result: SignalingResult) => void;
}

const SESSION_RETENTION_MS = 5 * 60_000;
const MAX_SESSIONS = 50;

export class CallSignalingClient {
  private readonly clock: Clock;
  private readonly newId: () => string;
  private readonly ackTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly offerDeadlineMs: number;
  private readonly controlDeadlineMs: number;

  private transport: SignalingTransport | null = null;
  private unsubscribeTransport: (() => void) | null = null;
  private disposed = false;

  private readonly sessions = new Map<string, CallSession>();
  private readonly pendingAcks = new Map<string, (ack: AckFrame) => void>();
  private readonly readyWaiters = new Set<() => void>();
  private readonly messageHandlers = new Set<(m: SignalingMessage) => void>();
  private readonly connectionHandlers = new Set<(s: SignalingConnectionState) => void>();

  constructor(private readonly opts: CallSignalingClientOptions) {
    this.clock = opts.clock ?? realClock;
    this.newId = opts.newId ?? newMessageId;
    this.ackTimeoutMs = opts.ackTimeoutMs ?? 3_000;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.offerDeadlineMs = opts.offerDeadlineMs ?? 6_000;
    this.controlDeadlineMs = opts.controlDeadlineMs ?? 30_000;
  }

  // ---- readiness -----------------------------------------------------------------

  isConfigured(): boolean { return this.opts.configured; }

  getConnectionState(): SignalingConnectionState {
    return this.transport?.getConnectionState() ?? "disconnected";
  }

  isReady(): boolean { return !!this.transport?.isReady(); }

  /**
   * "SELF-HOSTED CALL READY": authenticated AND registered by the gateway.
   * Resolves { ready:false, reason } (never throws) so the caller can fail
   * clearly and quickly. Does NOT fall back to anything.
   */
  async ensureReady(opts: { timeoutMs?: number } = {}): Promise<ReadyResult> {
    if (this.disposed) return { ready: false, reason: "DISPOSED" };
    if (!this.opts.configured) return { ready: false, reason: "NOT_CONFIGURED" };
    if (!this.opts.userId) return { ready: false, reason: "NO_USER" };
    const t = this.getTransport();
    if (t.isReady()) return { ready: true, waitedMs: 0 };
    const started = this.clock.now();
    try {
      await t.connect(opts.timeoutMs ?? 5_000);
      return { ready: true, waitedMs: this.clock.now() - started };
    } catch (err) {
      return { ready: false, reason: this.disposed ? "DISPOSED" : (String((err as Error)?.message).includes("DISCONNECTED") ? "DISPOSED" : "CONNECT_TIMEOUT") };
    }
  }

  /** Background connect so the first call/ring doesn't pay the handshake. */
  prewarm(): void {
    void this.ensureReady({ timeoutMs: 15_000 }).then((r) => {
      this.opts.onTelemetry?.("signaling_prewarm", { ready: r.ready, reason: r.reason });
    });
  }

  /** App resumed / network came back: reconnect now instead of waiting out a backoff. */
  nudge(): void { this.transport?.nudge(); }

  /** Network changed (online / connection type change): probe + reconnect. */
  onNetworkChange(): void {
    const t = this.transport;
    if (!t) return;
    if (t.checkLiveness) t.checkLiveness(); else t.nudge();
  }

  // ---- subscriptions --------------------------------------------------------------

  /** Validated, de-duplicated, session-checked inbound call events. */
  onMessage(handler: (m: SignalingMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => { this.messageHandlers.delete(handler); };
  }

  onConnectionState(handler: (s: SignalingConnectionState) => void): () => void {
    this.connectionHandlers.add(handler);
    return () => { this.connectionHandlers.delete(handler); };
  }

  // ---- sessions -------------------------------------------------------------------

  getSession(callId: string): CallSession | undefined { return this.sessions.get(callId); }

  /** Caller side: a new call attempt (called by offer()). */
  registerOutgoing(s: { callId: string; sessionId: string; peerId: string; callType?: "voice" | "video" }): CallSession {
    return this.putSession({ ...s, role: "caller", state: "RINGING" });
  }

  /** Receiver side, when the call is learned about WITHOUT a WebSocket
   *  offer (push / Realtime recovery / cold-start poll) so accept/reject
   *  can still go over the socket. No-op if a session already exists. */
  registerIncoming(s: { callId: string; sessionId: string; peerId: string; callType?: "voice" | "video" }): CallSession {
    const existing = this.sessions.get(s.callId);
    if (existing && existing.sessionId === s.sessionId) return existing;
    return this.putSession({ ...s, role: "receiver", state: "RINGING" });
  }

  /** App restarted mid-call: re-attach the session and resync. */
  registerRecovered(s: { callId: string; sessionId: string; peerId: string; role: "caller" | "receiver"; state: LocalCallState }): CallSession {
    const session = this.putSession(s);
    if (this.transport?.isReady() && !TERMINAL.has(session.state)) this.sendSync(session);
    return session;
  }

  // ---- critical sends -------------------------------------------------------------

  /** Ring the callee. Awaited by the caller: FAILED/TIMEOUT/REJECTED here
   *  means the call must not proceed as if it were ringing. */
  async offer(p: { callId: string; sessionId: string; peerId: string; callType: "voice" | "video" }, opts: SendOptions = {}): Promise<SignalingResult> {
    this.registerOutgoing(p);
    const r = await this.sendCritical(p.callId, "CALL_OFFER", undefined, { deadlineMs: this.offerDeadlineMs, ...opts });
    if (r.status === "REJECTED" || r.status === "FAILED" || r.status === "TIMEOUT") this.markLocal(p.callId, "ENDED");
    return r;
  }

  /** Callee → caller: "your call is ringing on my device" (telemetry/ack). */
  ringing(callId: string): Promise<SignalingResult> {
    const s = this.sessions.get(callId);
    if (!s || s.role !== "receiver" || s.state !== "RINGING") return Promise.resolve(this.noSession(callId));
    return this.sendCritical(callId, "CALL_RINGING", undefined, { returnQueued: true });
  }

  /** Callee, AFTER winning claim_call(). */
  accept(callId: string, opts: SendOptions = {}): Promise<SignalingResult> {
    const s = this.sessions.get(callId);
    if (!s || s.role !== "receiver") return Promise.resolve(this.noSession(callId));
    if (s.state === "ACCEPTED") return Promise.resolve(this.localDuplicate("ACCEPTED"));
    if (s.state !== "RINGING") return Promise.resolve(this.localRefusal("CALL_TERMINAL", s.state));
    this.markLocal(callId, "ACCEPTED"); // claim_call already won: our truth
    return this.sendCritical(callId, "CALL_ACCEPTED", undefined, { returnQueued: true, ...opts }).then((r) => {
      if (r.status === "REJECTED") {
        if (r.reason === "NOT_CLAIMED") this.markLocal(callId, "RINGING", true); // we never actually held the claim
        else if (r.state && r.state !== "RINGING" && r.state !== "ACCEPTED") this.markLocal(callId, r.state);
      }
      return r;
    });
  }

  /** Callee, AFTER decline_call() returned true. */
  reject(callId: string, reason: "user" | "timeout" = "user", opts: SendOptions = {}): Promise<SignalingResult> {
    const s = this.sessions.get(callId);
    if (!s || s.role !== "receiver") return Promise.resolve(this.noSession(callId));
    if (s.state === "REJECTED") return Promise.resolve(this.localDuplicate("REJECTED"));
    if (s.state !== "RINGING") return Promise.resolve(this.localRefusal(TERMINAL.has(s.state) ? "CALL_TERMINAL" : "INVALID_STATE", s.state));
    this.markLocal(callId, "REJECTED");
    return this.sendCritical(callId, "CALL_REJECTED", { reason }, { returnQueued: true, ...opts });
  }

  /** Caller, AFTER cancel_call() returned true. If the server says the
   *  callee already accepted, the cancel is refused and converted into an
   *  END — a stale cancel can never destroy a connected call. */
  async cancel(callId: string, opts: SendOptions = {}): Promise<SignalingResult> {
    const s = this.sessions.get(callId);
    if (!s || s.role !== "caller") return this.noSession(callId);
    if (s.state === "CANCELLED") return this.localDuplicate("CANCELLED");
    if (s.state === "ACCEPTED") return this.end(callId, opts);
    if (s.state !== "RINGING") return this.localRefusal("CALL_TERMINAL", s.state);
    this.markLocal(callId, "CANCELLED");

    // The refusal can arrive either inline or (if we were queued) later in
    // the background — convert to END in both cases, exactly once.
    let converted: Promise<SignalingResult> | null = null;
    const convert = (res: SignalingResult) => {
      if (!converted && res.status === "REJECTED" && res.reason === "INVALID_STATE" && res.state === "ACCEPTED") {
        this.markLocal(callId, "ACCEPTED", true);
        converted = this.end(callId, { ...opts, onSettled: undefined });
      }
    };
    const r = await this.sendCritical(callId, "CALL_CANCELLED", undefined, {
      returnQueued: true, ...opts,
      onSettled: (res) => { convert(res); opts.onSettled?.(res); },
    });
    return converted ?? r;
  }

  /** Either side, once the call was accepted. */
  end(callId: string, opts: SendOptions = {}): Promise<SignalingResult> {
    const s = this.sessions.get(callId);
    if (!s) return Promise.resolve(this.noSession(callId));
    if (s.state === "ENDED") return Promise.resolve(this.localDuplicate("ENDED"));
    if (s.state === "RINGING") return s.role === "caller" ? this.cancel(callId, opts) : this.reject(callId, "user", opts);
    if (s.state !== "ACCEPTED") return Promise.resolve(this.localRefusal("CALL_TERMINAL", s.state));
    this.markLocal(callId, "ENDED");
    return this.sendCritical(callId, "CALL_ENDED", undefined, { returnQueued: true, ...opts });
  }

  /** Hang up / abandon, whatever state the call is in. */
  terminate(callId: string, hint: { connected: boolean }, opts: SendOptions = {}): Promise<SignalingResult> {
    const s = this.sessions.get(callId);
    if (!s) return Promise.resolve(this.noSession(callId));
    if (hint.connected || s.state === "ACCEPTED") return this.end(callId, opts);
    return s.role === "caller" ? this.cancel(callId, opts) : this.reject(callId, "user", opts);
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeTransport?.();
    this.unsubscribeTransport = null;
    this.transport?.disconnect();
    this.transport = null;
    this.pendingAcks.clear();
    for (const w of Array.from(this.readyWaiters)) w();
    this.readyWaiters.clear();
    this.messageHandlers.clear();
    this.connectionHandlers.clear();
  }

  // ---- send engine ------------------------------------------------------------------

  private async sendCritical(
    callId: string, type: SignalingEventType, payload: Record<string, unknown> | undefined, opts: SendOptions,
  ): Promise<SignalingResult> {
    const msgId = this.newId();
    const session = this.sessions.get(callId);
    if (this.disposed) return { status: "FAILED", msgId, reason: "DISPOSED", attempts: 0 };
    if (!this.opts.configured) return { status: "FAILED", msgId, reason: "NOT_CONFIGURED", attempts: 0 };
    if (!session) return { status: "FAILED", msgId, reason: "NO_SESSION", attempts: 0 };

    const transport = this.getTransport();
    const deadlineMs = opts.deadlineMs ?? this.controlDeadlineMs;
    const run = () => this.runSend(transport, session, type, payload, msgId, deadlineMs);

    if (opts.returnQueued && !transport.isReady()) {
      this.opts.onTelemetry?.("signal_queued", { type });
      void run().then((r) => { opts.onSettled?.(r); this.opts.onTelemetry?.("signal_settled", { type, status: r.status }); });
      return { status: "QUEUED", msgId };
    }
    const result = await run();
    opts.onSettled?.(result);
    return result;
  }

  private async runSend(
    transport: SignalingTransport, session: CallSession, type: SignalingEventType,
    payload: Record<string, unknown> | undefined, msgId: string, deadlineMs: number,
  ): Promise<SignalingResult> {
    const started = this.clock.now();
    const deadline = started + deadlineMs;
    let attempts = 0;
    const remaining = () => deadline - this.clock.now();

    while (remaining() > 0 && !this.disposed) {
      if (!transport.isReady()) {
        if (transport.getConnectionState() === "disconnected") void transport.connect(Math.max(1, remaining())).catch(() => { /* reported via the send result */ });
        transport.nudge();
        if (!(await this.waitReady(remaining()))) break;
        continue;
      }
      if (attempts >= this.maxAttempts) break;

      const frame: OutboundSignal = { type, callId: session.callId, recipientId: session.peerId, sessionId: session.sessionId, msgId, ...(payload ? { payload } : {}) };
      attempts += 1;
      const ackPromise = this.waitAck(msgId, Math.min(this.ackTimeoutMs, Math.max(1, remaining())));
      if (!transport.sendFrame(frame)) {
        this.pendingAcks.delete(msgId);
        await this.sleep(Math.min(150 * attempts, Math.max(0, remaining())));
        continue;
      }
      const ack = await ackPromise;
      if (!ack) { this.opts.onTelemetry?.("signal_ack_timeout", { type, attempts }); continue; }

      const latencyMs = this.clock.now() - started;
      if (ack.status === "REJECTED") {
        const reason = ack.reason ?? "INVALID_STATE";
        if (RETRYABLE_REJECT_REASONS.has(reason)) { await this.sleep(Math.min(300 * attempts, Math.max(0, remaining()))); continue; }
        return { status: "REJECTED", msgId, reason, state: ack.state, attempts, latencyMs };
      }
      return { status: ack.status, msgId, state: ack.state, attempts, latencyMs };
    }
    return attempts > 0 ? { status: "TIMEOUT", msgId, attempts } : { status: "FAILED", msgId, reason: "NOT_READY", attempts };
  }

  private waitAck(msgId: string, ms: number): Promise<AckFrame | null> {
    return new Promise((resolve) => {
      const timer = this.clock.setTimeout(() => { this.pendingAcks.delete(msgId); resolve(null); }, ms);
      this.pendingAcks.set(msgId, (ack) => { this.clock.clearTimeout(timer); this.pendingAcks.delete(msgId); resolve(ack); });
    });
  }

  private waitReady(ms: number): Promise<boolean> {
    if (ms <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      let timer: unknown;
      const onReady = () => { this.clock.clearTimeout(timer); this.readyWaiters.delete(onReady); resolve(this.isReady()); };
      timer = this.clock.setTimeout(() => { this.readyWaiters.delete(onReady); resolve(false); }, ms);
      this.readyWaiters.add(onReady);
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => { this.clock.setTimeout(resolve, ms); });
  }

  // ---- inbound ----------------------------------------------------------------------

  private getTransport(): SignalingTransport {
    if (!this.transport) {
      this.transport = this.opts.createTransport();
      this.unsubscribeTransport = this.transport.subscribe((e) => this.onTransportEvent(e));
    }
    return this.transport;
  }

  private onTransportEvent(e: TransportEvent): void {
    switch (e.kind) {
      case "ack": this.pendingAcks.get(e.frame.msgId)?.(e.frame); return;
      case "state": this.applyState(e.frame); return;
      case "signal": this.onInbound(e.message); return;
      case "connection": for (const h of Array.from(this.connectionHandlers)) h(e.state); return;
      case "ready":
        for (const w of Array.from(this.readyWaiters)) w();
        if (e.reconnected) for (const s of this.liveSessions()) this.sendSync(s);
        return;
    }
  }

  private onInbound(msg: SignalingMessage): void {
    const me = this.opts.userId;
    if (!me || msg.recipientId !== me) return this.drop("wrong_recipient", msg);
    const existing = this.sessions.get(msg.callId);

    if (msg.type === "CALL_OFFER") {
      if (msg.senderId === me) return this.drop("self_offer", msg);
      if (existing) return this.drop(existing.sessionId === msg.sessionId ? "duplicate_offer" : "offer_session_mismatch", msg);
      const callType = msg.payload?.callType === "video" ? "video" : msg.payload?.callType === "voice" ? "voice" : undefined;
      this.putSession({ callId: msg.callId, sessionId: msg.sessionId, peerId: msg.senderId, role: "receiver", state: "RINGING", callType });
      return this.emitMessage(msg);
    }

    if (!existing) return this.drop("unknown_call", msg);
    if (existing.sessionId !== msg.sessionId) return this.drop("stale_session", msg);
    // Only the call's peer (or the server itself, for ring timeout) may drive it.
    if (msg.type === "CALL_TIMEOUT" ? msg.senderId !== SERVER_SENDER_ID : msg.senderId !== existing.peerId) return this.drop("wrong_sender", msg);

    const s = existing;
    switch (msg.type) {
      case "CALL_ACCEPTED":
        if (s.role !== "caller" || s.state !== "RINGING") return this.drop("illegal_accept", msg);
        s.state = "ACCEPTED"; break;
      case "CALL_REJECTED":
      case "CALL_BUSY":
        if (s.role !== "caller" || s.state !== "RINGING") return this.drop("illegal_reject", msg);
        s.state = msg.type === "CALL_BUSY" ? "BUSY" : "REJECTED"; break;
      case "CALL_CANCELLED":
        if (s.role !== "receiver" || s.state !== "RINGING") return this.drop("illegal_cancel", msg);
        s.state = "CANCELLED"; break;
      case "CALL_TIMEOUT":
        if (s.state !== "RINGING") return this.drop("illegal_timeout", msg);
        s.state = "TIMED_OUT"; break;
      case "CALL_ENDED":
        if (s.state !== "ACCEPTED") return this.drop("illegal_end", msg);
        s.state = "ENDED"; break;
      case "CALL_RINGING":
        if (s.role !== "caller" || s.state !== "RINGING") return this.drop("illegal_ringing", msg);
        break;
      case "PARTICIPANT_READY":
      case "NETWORK_CHANGED":
      case "RECONNECT_REQUEST":
        if (TERMINAL.has(s.state)) return this.drop("terminal_relay", msg);
        break;
      default:
        return this.drop("unhandled_type", msg);
    }
    s.updatedAt = this.clock.now();
    this.emitMessage(msg);
  }

  /** Reconnect resync: reconcile with what the gateway says happened. */
  private applyState(f: { callId: string; sessionId: string; state: ServerCallState | "UNKNOWN" }): void {
    const s = this.sessions.get(f.callId);
    if (!s || s.sessionId !== f.sessionId || f.state === "UNKNOWN" || f.state === s.state) return;
    const synth = (type: SignalingEventType, from: string): void => {
      this.onInbound({ type, callId: s.callId, sessionId: s.sessionId, senderId: from, recipientId: this.opts.userId as string, ts: this.clock.now(), payload: { viaSync: true } });
    };
    switch (f.state) {
      case "ACCEPTED": if (s.role === "caller" && s.state === "RINGING") synth("CALL_ACCEPTED", s.peerId); return;
      case "REJECTED": if (s.role === "caller" && s.state === "RINGING") synth("CALL_REJECTED", s.peerId); return;
      case "BUSY": if (s.role === "caller" && s.state === "RINGING") synth("CALL_BUSY", s.peerId); return;
      case "CANCELLED": if (s.role === "receiver" && s.state === "RINGING") synth("CALL_CANCELLED", s.peerId); return;
      case "TIMED_OUT": if (s.state === "RINGING") synth("CALL_TIMEOUT", SERVER_SENDER_ID); return;
      case "ENDED":
        if (s.state === "RINGING") {
          // Accepted and ended entirely while we were offline: surface the
          // accept first (so state stays legal), then the end.
          if (s.role === "caller") synth("CALL_ACCEPTED", s.peerId);
          else s.state = "ACCEPTED";
        }
        if (s.state === "ACCEPTED") synth("CALL_ENDED", s.peerId);
        return;
      default: return;
    }
  }

  private sendSync(s: CallSession): void {
    this.transport?.sendFrame({ type: "CALL_SYNC", callId: s.callId, recipientId: s.peerId, sessionId: s.sessionId, msgId: this.newId() });
  }

  private liveSessions(): CallSession[] {
    return Array.from(this.sessions.values()).filter((s) => !TERMINAL.has(s.state));
  }

  // ---- helpers ----------------------------------------------------------------------

  private putSession(s: Omit<CallSession, "updatedAt">): CallSession {
    const now = this.clock.now();
    for (const [id, v] of this.sessions) if (TERMINAL.has(v.state) && now - v.updatedAt > SESSION_RETENTION_MS) this.sessions.delete(id);
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = Array.from(this.sessions.values()).sort((a, b) => a.updatedAt - b.updatedAt)[0];
      if (oldest) this.sessions.delete(oldest.callId);
    }
    const session: CallSession = { ...s, updatedAt: now };
    this.sessions.set(s.callId, session);
    return session;
  }

  private markLocal(callId: string, state: LocalCallState, force = false): void {
    const s = this.sessions.get(callId);
    if (!s) return;
    if (!force && TERMINAL.has(s.state) && s.state !== state) return;
    s.state = state;
    s.updatedAt = this.clock.now();
  }

  private emitMessage(m: SignalingMessage): void {
    for (const h of Array.from(this.messageHandlers)) {
      try { h(m); } catch { /* a bad listener must not break signaling */ }
    }
  }

  private drop(reason: string, msg: SignalingMessage): void {
    this.opts.onTelemetry?.("signal_dropped", { reason, type: msg.type });
  }

  private noSession(_callId: string): SignalingResult {
    return { status: "FAILED", msgId: this.newId(), reason: "NO_SESSION", attempts: 0 };
  }
  private localDuplicate(state: ServerCallState): SignalingResult {
    return { status: "DUPLICATE", msgId: this.newId(), state, attempts: 0, latencyMs: 0 };
  }
  private localRefusal(reason: "CALL_TERMINAL" | "INVALID_STATE", state: LocalCallState): SignalingResult {
    return { status: "REJECTED", msgId: this.newId(), reason, state, attempts: 0, latencyMs: 0 };
  }
}

export { isServerAccepted };

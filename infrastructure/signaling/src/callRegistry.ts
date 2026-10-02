/**
 * callRegistry — the signaling server's EPHEMERAL per-call state, plus
 * the pure transition rules that decide whether an event is legal for a
 * call's current state.
 *
 * WHAT THIS IS / IS NOT: Supabase call_history remains the persistent
 * source of truth. This registry only exists so the router can refuse
 * obviously stale or invalid control events without a database round
 * trip per message:
 *
 *   unknown call · unauthorized sender · unauthorized recipient ·
 *   wrong/old session · CALL_ACCEPTED after a terminal state ·
 *   CALL_REJECTED after accepted · CALL_CANCELLED after accepted/ended ·
 *   CALL_ENDED from a non-participant
 *
 * Entries are seeded from the authoritative facts the CallAuthorizer
 * returns (authorizer.ts) — never from anything the client claims — and
 * are lost on process restart by design: an unknown callId is simply
 * re-resolved from Supabase on its next message.
 */
import {
  TERMINAL_CALL_STATES,
  type RejectReason,
  type ServerCallState,
  type SignalingEventType,
  type SignalingMessage,
} from "./types.js";

export interface CallEntry {
  callId: string;
  sessionId: string;
  callerId: string;
  receiverId: string;
  callType: "voice" | "video";
  state: ServerCallState;
  /** ms epoch — after this a RINGING call is TIMED_OUT by the sweep. */
  ringExpiresAt: number;
  updatedAt: number;
  /** True once an OFFER was actually written to the callee's live socket. */
  offerDelivered: boolean;
  /** True only once facts fetched FOR an OFFER confirmed the two parties
   *  are (still) partners. An entry rebuilt from a non-OFFER message
   *  (server restart, late connect) has this false, so a later OFFER
   *  re-checks the relationship instead of inheriting trust. */
  partnersVerified: boolean;
  /** The server-built OFFER (already stamped) held for replay if the
   *  callee connects while the call is still ringing. Cleared on any
   *  state change away from RINGING. */
  pendingOffer: SignalingMessage | null;
}

export type TransitionDecision =
  | { ok: true; next: ServerCallState; changed: boolean }
  | { ok: false; reason: RejectReason; state: ServerCallState };

/** Which participant role may send which lifecycle event, and from which
 *  states. `from` lists the states where the event APPLIES (changes
 *  state); a repeat in the already-resulting state is idempotent and
 *  handled separately as a DUPLICATE. */
interface Rule {
  sender: "caller" | "receiver" | "either";
  from: ReadonlyArray<ServerCallState>;
  to: ServerCallState;
}

const RULES: Partial<Record<SignalingEventType, Rule>> = {
  CALL_ACCEPTED: { sender: "receiver", from: ["RINGING"], to: "ACCEPTED" },
  CALL_REJECTED: { sender: "receiver", from: ["RINGING"], to: "REJECTED" },
  CALL_BUSY: { sender: "receiver", from: ["RINGING"], to: "BUSY" },
  CALL_CANCELLED: { sender: "caller", from: ["RINGING"], to: "CANCELLED" },
  CALL_ENDED: { sender: "either", from: ["ACCEPTED"], to: "ENDED" },
};

export function roleOf(entry: CallEntry, userId: string): "caller" | "receiver" | null {
  if (userId === entry.callerId) return "caller";
  if (userId === entry.receiverId) return "receiver";
  return null;
}

export function counterpartOf(entry: CallEntry, userId: string): string | null {
  const role = roleOf(entry, userId);
  if (role === "caller") return entry.receiverId;
  if (role === "receiver") return entry.callerId;
  return null;
}

/** Pure: is `type` from `senderId` legal for `entry` right now? Does NOT
 *  check session id, recipient, or DB-backed facts — the gateway does
 *  those; this is only the state machine. */
export function evaluateTransition(entry: CallEntry, type: SignalingEventType, senderId: string): TransitionDecision {
  const role = roleOf(entry, senderId);
  if (!role) return { ok: false, reason: "NOT_A_PARTICIPANT", state: entry.state };

  const rule = RULES[type];
  if (!rule) return { ok: false, reason: "INVALID_STATE", state: entry.state };

  if (rule.sender !== "either" && rule.sender !== role) {
    // Right participant, wrong direction (e.g. the caller sending
    // CALL_ACCEPTED, or the callee sending CALL_CANCELLED).
    return { ok: false, reason: "INVALID_STATE", state: entry.state };
  }

  // Idempotent repeat: the event has already been applied.
  if (entry.state === rule.to) return { ok: true, next: entry.state, changed: false };

  if (rule.from.includes(entry.state)) return { ok: true, next: rule.to, changed: true };

  if (TERMINAL_CALL_STATES.has(entry.state)) {
    return { ok: false, reason: "CALL_TERMINAL", state: entry.state };
  }
  // Non-terminal but wrong state, e.g. CALL_CANCELLED once ACCEPTED, or
  // CALL_ENDED while still RINGING.
  return { ok: false, reason: "INVALID_STATE", state: entry.state };
}

export class CallRegistry {
  private entries = new Map<string, CallEntry>();

  constructor(
    private readonly terminalRetentionMs = 5 * 60_000,
    private readonly maxEntries = 5_000,
  ) {}

  get(callId: string): CallEntry | undefined {
    return this.entries.get(callId);
  }

  put(entry: CallEntry): void {
    if (this.entries.size >= this.maxEntries && !this.entries.has(entry.callId)) this.evictOldest();
    this.entries.set(entry.callId, entry);
  }

  transition(entry: CallEntry, next: ServerCallState, now: number): void {
    entry.state = next;
    entry.updatedAt = now;
    if (next !== "RINGING") entry.pendingOffer = null;
  }

  /** Non-terminal (RINGING/ACCEPTED) calls involving `userId`, oldest first. */
  activeCallsFor(userId: string): CallEntry[] {
    const out: CallEntry[] = [];
    for (const e of this.entries.values()) {
      if (TERMINAL_CALL_STATES.has(e.state)) continue;
      if (e.callerId === userId || e.receiverId === userId) out.push(e);
    }
    return out.sort((a, b) => a.updatedAt - b.updatedAt);
  }

  /** RINGING calls addressed to `userId` that still have a held OFFER
   *  and haven't expired — replayed when the callee's socket connects. */
  pendingOffersFor(userId: string, now: number): CallEntry[] {
    const out: CallEntry[] = [];
    for (const e of this.entries.values()) {
      if (e.state === "RINGING" && e.receiverId === userId && e.pendingOffer && e.ringExpiresAt > now) out.push(e);
    }
    return out;
  }

  /** Flip expired RINGING calls to TIMED_OUT and drop old terminal
   *  entries. Returns the calls that just timed out so the gateway can
   *  notify both participants. */
  sweep(now: number): CallEntry[] {
    const timedOut: CallEntry[] = [];
    for (const [id, e] of this.entries) {
      if (e.state === "RINGING" && e.ringExpiresAt <= now) {
        this.transition(e, "TIMED_OUT", now);
        timedOut.push(e);
      } else if (TERMINAL_CALL_STATES.has(e.state) && now - e.updatedAt > this.terminalRetentionMs) {
        this.entries.delete(id);
      }
    }
    return timedOut;
  }

  size(): number {
    return this.entries.size;
  }

  private evictOldest(): void {
    // Bounded memory: prefer evicting the oldest TERMINAL entry; fall
    // back to the oldest of anything (an evicted live call is simply
    // re-resolved from Supabase on its next message).
    let victim: CallEntry | undefined;
    for (const e of this.entries.values()) {
      const candidateBetter = !victim
        || (TERMINAL_CALL_STATES.has(e.state) && !TERMINAL_CALL_STATES.has(victim.state))
        || (TERMINAL_CALL_STATES.has(e.state) === TERMINAL_CALL_STATES.has(victim.state) && e.updatedAt < victim.updatedAt);
      if (candidateBetter) victim = e;
    }
    if (victim) this.entries.delete(victim.callId);
  }
}

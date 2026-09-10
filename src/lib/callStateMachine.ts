/**
 * callStateMachine — single authoritative source of truth for call
 * lifecycle state, with generation IDs for race safety.
 *
 * WHY THIS EXISTS
 * ----------------
 * Today, "what call are we in, and how far along is it" is answered by
 * reading several independent pieces of state and hoping they agree:
 *   - useDailyCall's `callState` ("idle" | "joining" | "joined" | "error")
 *   - CallContext's `isAcceptingCall` boolean
 *   - CallContext's `acceptCancelledRef` / `acceptLockRef`
 *   - Calls.tsx's page-local `callCancelledRef` / `startCallLockRef`
 *   - `activeCallId` / `activeCallType`
 * Each of these was added to fix a specific race (double-tap, cancel-
 * during-accept, stale claim response, ...) and each fix is correct in
 * isolation — but nothing stops a *future* async callback from reading a
 * stale combination of them, and every call site that wants to know
 * "are we mid-call-setup right now" has to know about all of them.
 *
 * This module replaces that with one small reducer: an explicit state
 * enum, a legal-transition table (illegal transitions are rejected, not
 * silently applied), and a monotonically increasing `generation` that
 * increments on every transition. Any in-flight async work (a claim RPC,
 * a token fetch, a Daily join) captures the generation it started with;
 * when it resolves, it calls `isCurrent(gen)` before acting on its
 * result. If the generation has moved on — a newer call started, the
 * user cancelled, a decline arrived — the stale result is a no-op.
 *
 * This is purely additive: it does not call Supabase, Daily, or any
 * native bridge. It only tracks *what state we believe we're in* and
 * *whether a given async result still applies*. CallContext/useDailyCall
 * remain the things that actually do the work; this is what they
 * consult/update while doing it.
 */

export type CallDirection = "outgoing" | "incoming";

export type CallLifecycleState =
  | "IDLE"
  | "OUTGOING_PREPARING"
  | "OUTGOING_RINGING"
  | "INCOMING_RINGING"
  | "ACCEPTING"
  | "CONNECTING"
  | "CONNECTED"
  | "RECONNECTING"
  | "DECLINED"
  | "CANCELLED"
  | "MISSED"
  | "BUSY"
  | "FAILED"
  | "ENDED";

/** Terminal states — every one of these must settle back to IDLE (via
 *  RESET) before a new call can start. Listing them explicitly (rather
 *  than deriving "terminal" from "not in this set") makes it obvious at
 *  a glance which states are dead ends. */
const TERMINAL_STATES: ReadonlySet<CallLifecycleState> = new Set([
  "DECLINED", "CANCELLED", "MISSED", "BUSY", "FAILED", "ENDED",
]);

export interface CallSession {
  /** call_history.id — null only in IDLE, before any row exists yet
   *  (e.g. OUTGOING_PREPARING, before the insert has returned). */
  callId: string | null;
  direction: CallDirection | null;
  callType: "video" | "voice" | null;
}

export interface CallMachineState {
  status: CallLifecycleState;
  session: CallSession;
  /** Increments on every accepted transition. This is the value async
   *  work should capture and later check via isCurrent(). */
  generation: number;
  /** Debugging aid — who/what caused the last transition
   *  ("user-tap" | "realtime" | "push" | "claim-rpc" | "daily-event" | ...). */
  lastSource: string;
  lastTransitionAt: number;
}

export type CallMachineEvent =
  | { type: "START_OUTGOING"; callType: "video" | "voice"; source: string }
  | { type: "OUTGOING_SESSION_CREATED"; callId: string; source: string }
  | { type: "OUTGOING_RINGING"; source: string }
  | { type: "INCOMING_CALL"; callId: string; callType: "video" | "voice"; source: string }
  | { type: "ACCEPT_TAPPED"; source: string }
  | { type: "CLAIM_WON"; source: string }
  | { type: "CONNECTING"; source: string }
  | { type: "CONNECTED"; source: string }
  | { type: "RECONNECTING"; source: string }
  | { type: "RECOVERED"; source: string } // RECONNECTING -> CONNECTED
  | { type: "DECLINED"; source: string }
  | { type: "CANCELLED"; source: string }
  | { type: "MISSED"; source: string }
  | { type: "BUSY"; source: string }
  | { type: "FAILED"; source: string }
  | { type: "ENDED"; source: string }
  | { type: "RESET"; source: string };

/** Legal transition table: for each state, which event types are
 *  accepted and which state they lead to. Anything not listed here is
 *  an illegal transition and is rejected (see `reduceCallMachine`). */
const TRANSITIONS: Partial<Record<CallLifecycleState, Partial<Record<CallMachineEvent["type"], CallLifecycleState>>>> = {
  IDLE: {
    START_OUTGOING: "OUTGOING_PREPARING",
    INCOMING_CALL: "INCOMING_RINGING",
  },
  OUTGOING_PREPARING: {
    OUTGOING_SESSION_CREATED: "OUTGOING_RINGING",
    CANCELLED: "CANCELLED",
    FAILED: "FAILED",
    BUSY: "BUSY",
  },
  OUTGOING_RINGING: {
    CONNECTING: "CONNECTING",
    CANCELLED: "CANCELLED",
    DECLINED: "DECLINED",
    MISSED: "MISSED",
    BUSY: "BUSY",
    FAILED: "FAILED",
  },
  INCOMING_RINGING: {
    ACCEPT_TAPPED: "ACCEPTING",
    DECLINED: "DECLINED",
    CANCELLED: "CANCELLED", // caller cancelled before we answered
    MISSED: "MISSED",
  },
  ACCEPTING: {
    CLAIM_WON: "CONNECTING",
    CANCELLED: "CANCELLED", // we cancelled our own accept, or lost the claim race
    FAILED: "FAILED",
  },
  CONNECTING: {
    CONNECTED: "CONNECTED",
    CANCELLED: "CANCELLED",
    FAILED: "FAILED",
    ENDED: "ENDED", // hang-up tapped before media ever came up
  },
  CONNECTED: {
    RECONNECTING: "RECONNECTING",
    ENDED: "ENDED",
    FAILED: "FAILED",
  },
  RECONNECTING: {
    RECOVERED: "CONNECTED",
    ENDED: "ENDED",
    FAILED: "FAILED",
  },
  // Terminal states only accept RESET, handled generically below.
};

const emptySession: CallSession = { callId: null, direction: null, callType: null };

export const initialCallMachineState: CallMachineState = {
  status: "IDLE",
  session: emptySession,
  generation: 0,
  lastSource: "init",
  lastTransitionAt: Date.now(),
};

/**
 * Pure reducer. Returns a NEW state object only on an accepted
 * transition (so callers can cheaply detect "did anything actually
 * change" via reference equality); returns the SAME object, unchanged,
 * on a rejected one, and logs why in dev.
 */
export function reduceCallMachine(state: CallMachineState, event: CallMachineEvent): CallMachineState {
  if (event.type === "RESET") {
    if (!TERMINAL_STATES.has(state.status) && state.status !== "IDLE") {
      // Defense in depth: resetting out of a non-terminal, non-idle state
      // (e.g. straight out of CONNECTED) is allowed — a hard leaveCall()
      // needs an escape hatch — but it's worth knowing about, since it
      // usually means an ENDED/FAILED event should have been dispatched
      // first and wasn't.
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn(`[callStateMachine] RESET from non-terminal state ${state.status} (source: ${event.source})`);
      }
    }
    return {
      status: "IDLE",
      session: emptySession,
      generation: state.generation + 1,
      lastSource: event.source,
      lastTransitionAt: Date.now(),
    };
  }

  const next = TRANSITIONS[state.status]?.[event.type];
  if (!next) {
    // Illegal/stale transition — e.g. a DECLINED arriving after the call
    // already reached CONNECTED, or a duplicate ACCEPT_TAPPED. Reject
    // rather than silently applying: the caller's generation guard
    // (isCurrent) is the usual reason this fires, so it's expected to
    // happen occasionally and is not itself an error — just a no-op.
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.warn(`[callStateMachine] rejected ${event.type} from ${state.status} (source: ${event.source})`);
    }
    return state;
  }

  const session: CallSession = (() => {
    switch (event.type) {
      case "START_OUTGOING":
        return { callId: null, direction: "outgoing", callType: event.callType };
      case "OUTGOING_SESSION_CREATED":
        return { ...state.session, callId: event.callId };
      case "INCOMING_CALL":
        return { callId: event.callId, direction: "incoming", callType: event.callType };
      default:
        return state.session;
    }
  })();

  return {
    status: next,
    session,
    generation: state.generation + 1,
    lastSource: event.source,
    lastTransitionAt: Date.now(),
  };
}

/** True if `generation` is still the machine's current generation —
 *  i.e. nothing has transitioned since the async work that captured it
 *  was kicked off. Async callbacks (claim result, token result, Daily
 *  join resolution, a realtime/push payload) should check this before
 *  acting on their result, and treat `false` as "discard, this is
 *  stale" rather than an error. */
export function isCurrentGeneration(state: CallMachineState, generation: number): boolean {
  return state.generation === generation;
}

/** True if `callId` matches the session the machine currently believes
 *  is active. Use alongside (not instead of) isCurrentGeneration for
 *  events that name a specific call (realtime UPDATE/INSERT rows, push
 *  payloads) — generation alone tells you "something changed since you
 *  started", this tells you "...and it wasn't even about this call". */
export function isCurrentCall(state: CallMachineState, callId: string): boolean {
  return state.session.callId === callId;
}

export function isTerminal(status: CallLifecycleState): boolean {
  return TERMINAL_STATES.has(status);
}

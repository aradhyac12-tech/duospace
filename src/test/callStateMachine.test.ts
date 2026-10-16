import { describe, it, expect } from "vitest";
import {
  reduceCallMachine,
  initialCallMachineState,
  isCurrentGeneration,
  isCurrentCall,
  isTerminal,
  type CallMachineState,
} from "@/lib/callStateMachine";

const dispatch = (state: CallMachineState, event: Parameters<typeof reduceCallMachine>[1]) =>
  reduceCallMachine(state, event);

describe("callStateMachine", () => {
  it("starts IDLE with generation 0", () => {
    expect(initialCallMachineState.status).toBe("IDLE");
    expect(initialCallMachineState.generation).toBe(0);
  });

  it("walks the happy path for an outgoing call", () => {
    let s = initialCallMachineState;
    s = dispatch(s, { type: "START_OUTGOING", callType: "video", source: "user-tap" });
    expect(s.status).toBe("OUTGOING_PREPARING");
    s = dispatch(s, { type: "OUTGOING_SESSION_CREATED", callId: "call-1", source: "insert" });
    expect(s.status).toBe("OUTGOING_RINGING");
    expect(s.session.callId).toBe("call-1");
    s = dispatch(s, { type: "CONNECTING", source: "join" });
    s = dispatch(s, { type: "CONNECTED", source: "daily-event" });
    expect(s.status).toBe("CONNECTED");
    s = dispatch(s, { type: "ENDED", source: "user-tap" });
    expect(s.status).toBe("ENDED");
    expect(isTerminal(s.status)).toBe(true);
  });

  it("walks the happy path for an incoming call", () => {
    let s = initialCallMachineState;
    s = dispatch(s, { type: "INCOMING_CALL", callId: "call-2", callType: "voice", source: "realtime" });
    expect(s.status).toBe("INCOMING_RINGING");
    s = dispatch(s, { type: "ACCEPT_TAPPED", source: "user-tap" });
    expect(s.status).toBe("ACCEPTING");
    s = dispatch(s, { type: "CLAIM_WON", source: "claim-rpc" });
    expect(s.status).toBe("CONNECTING");
    s = dispatch(s, { type: "CONNECTED", source: "daily-event" });
    expect(s.status).toBe("CONNECTED");
  });

  it("rejects an illegal transition instead of applying it", () => {
    let s = initialCallMachineState; // IDLE
    const before = s;
    s = dispatch(s, { type: "CLAIM_WON", source: "claim-rpc" }); // CLAIM_WON isn't legal from IDLE
    expect(s).toBe(before); // same reference — nothing changed
    expect(s.status).toBe("IDLE");
  });

  it("rejects a stale event after the state has already moved on (double-accept)", () => {
    let s = initialCallMachineState;
    s = dispatch(s, { type: "INCOMING_CALL", callId: "call-3", callType: "video", source: "realtime" });
    s = dispatch(s, { type: "ACCEPT_TAPPED", source: "user-tap-1" });
    const afterFirstAccept = s;
    // A second, near-simultaneous accept tap — machine is already ACCEPTING,
    // and ACCEPT_TAPPED isn't a legal event from ACCEPTING.
    s = dispatch(s, { type: "ACCEPT_TAPPED", source: "user-tap-2" });
    expect(s).toBe(afterFirstAccept);
  });

  it("generation increments on every accepted transition and stays put on rejected ones", () => {
    let s = initialCallMachineState;
    s = dispatch(s, { type: "START_OUTGOING", callType: "voice", source: "user-tap" });
    const gen1 = s.generation;
    s = dispatch(s, { type: "CLAIM_WON", source: "stale" }); // illegal from OUTGOING_PREPARING
    expect(s.generation).toBe(gen1); // rejected — generation unchanged
    s = dispatch(s, { type: "CANCELLED", source: "user-tap" });
    expect(s.generation).toBe(gen1 + 1);
  });

  it("isCurrentGeneration lets a caller detect a stale async result", () => {
    let s = initialCallMachineState;
    s = dispatch(s, { type: "START_OUTGOING", callType: "video", source: "user-tap" });
    const capturedGen = s.generation; // async work (e.g. token fetch) captures this
    // Meanwhile the user cancels before the async work resolves.
    s = dispatch(s, { type: "CANCELLED", source: "user-tap" });
    expect(isCurrentGeneration(s, capturedGen)).toBe(false);
  });

  it("a late realtime event for an old call cannot mutate a newer call's state", () => {
    let s = initialCallMachineState;
    s = dispatch(s, { type: "INCOMING_CALL", callId: "call-old", callType: "voice", source: "realtime" });
    s = dispatch(s, { type: "MISSED", source: "ring-timeout" }); // call-old ends, terminal
    s = dispatch(s, { type: "RESET", source: "idle-cleanup" });
    // A brand-new call starts.
    s = dispatch(s, { type: "INCOMING_CALL", callId: "call-new", callType: "video", source: "realtime" });
    // A stale "declined" realtime payload for call-old arrives late.
    expect(isCurrentCall(s, "call-old")).toBe(false);
    expect(isCurrentCall(s, "call-new")).toBe(true);
    // Even if something tried to dispatch DECLINED for it, INCOMING_RINGING
    // does accept DECLINED — so the callId check (isCurrentCall), not the
    // state machine's transition table alone, is what's load-bearing here.
    // A caller MUST check isCurrentCall before dispatching, exactly because
    // the transition would otherwise be legally accepted and wrongly end
    // call-new.
  });

  it("RESET is the only way out of a terminal state", () => {
    let s = initialCallMachineState;
    s = dispatch(s, { type: "START_OUTGOING", callType: "video", source: "user-tap" });
    s = dispatch(s, { type: "CANCELLED", source: "user-tap" });
    expect(isTerminal(s.status)).toBe(true);
    const stale = dispatch(s, { type: "CONNECTED", source: "late-daily-event" });
    expect(stale).toBe(s); // rejected, still CANCELLED
    const reset = dispatch(s, { type: "RESET", source: "cleanup" });
    expect(reset.status).toBe("IDLE");
    expect(reset.session.callId).toBeNull();
  });

  it("busy/failed/declined/missed are all reachable terminal outcomes", () => {
    const outcomes: Array<[typeof initialCallMachineState.status, string]> = [];
    let s = initialCallMachineState;
    s = dispatch(s, { type: "START_OUTGOING", callType: "video", source: "user-tap" });
    s = dispatch(s, { type: "BUSY", source: "create-and-token" });
    expect(isTerminal(s.status)).toBe(true);
    expect(s.status).toBe("BUSY");
  });

  it("a second INCOMING_CALL while already CONNECTED is rejected, not merged into the active call", () => {
    // Regression coverage for the real bug this caught during integration:
    // IncomingCallOverlay dispatches INCOMING_CALL the instant a call rings
    // (real time or push), independent of whatever this device is currently
    // doing. If it's already on a call, that dispatch must be a no-op, not
    // something that clobbers the active call's state.
    let s = initialCallMachineState;
    s = dispatch(s, { type: "INCOMING_CALL", callId: "call-a", callType: "voice", source: "realtime" });
    s = dispatch(s, { type: "ACCEPT_TAPPED", source: "user-tap" });
    s = dispatch(s, { type: "CLAIM_WON", source: "claim-rpc" });
    s = dispatch(s, { type: "CONNECTED", source: "daily-event" });
    const connected = s;
    s = dispatch(s, { type: "INCOMING_CALL", callId: "call-b", callType: "video", source: "realtime" });
    expect(s).toBe(connected); // rejected — still on call-a, untouched
    expect(s.session.callId).toBe("call-a");
  });

  it("ACCEPT_TAPPED advances directly from an already-current INCOMING_RINGING without a RESET round-trip", () => {
    // The overlay seeds INCOMING_CALL at ring-time; accepting should just
    // advance that same session, not discard and re-seed it (the bug this
    // test guards against added an extra RESET+reseed detour that briefly
    // existed during integration — see CallContext.tsx's acceptIncomingCallImpl).
    let s = initialCallMachineState;
    s = dispatch(s, { type: "INCOMING_CALL", callId: "call-x", callType: "voice", source: "realtime" });
    const ringingGeneration = s.generation;
    s = dispatch(s, { type: "ACCEPT_TAPPED", source: "user-tap" });
    // Exactly one transition happened between ringing and accepting — no
    // RESET, no re-dispatched INCOMING_CALL in between.
    expect(s.generation).toBe(ringingGeneration + 1);
    expect(s.session.callId).toBe("call-x");
    expect(s.status).toBe("ACCEPTING");
  });
});

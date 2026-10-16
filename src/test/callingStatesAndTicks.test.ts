import { describe, it, expect } from "vitest";
import { deriveCallUiState, CALL_UI_STATE_LABEL } from "@/lib/callUiState";

const base = {
  callState: "joined" as const,
  isStartingCall: false,
  participantCount: 1,
  everConnected: false,
  networkQuality: "good" as const,
};

describe("outgoing call: Calling… -> Ringing… (WhatsApp-style)", () => {
  it("shows 'calling' from the tap until the callee device is reached", () => {
    expect(deriveCallUiState({ ...base, callState: "idle", isStartingCall: true, direction: "outgoing", peerRinging: false })).toBe("calling");
    expect(deriveCallUiState({ ...base, callState: "joining", direction: "outgoing", peerRinging: false })).toBe("calling");
  });

  it("stays 'calling' once joined but the callee has not been reached", () => {
    expect(deriveCallUiState({ ...base, direction: "outgoing", peerRinging: false })).toBe("calling");
  });

  it("flips to 'ringing' when the callee device is reached", () => {
    expect(deriveCallUiState({ ...base, direction: "outgoing", peerRinging: true })).toBe("ringing");
    expect(deriveCallUiState({ ...base, callState: "joining", direction: "outgoing", peerRinging: true })).toBe("ringing");
  });

  it("legacy callers (peerRinging omitted) keep showing 'ringing'", () => {
    expect(deriveCallUiState({ ...base, direction: "outgoing" })).toBe("ringing");
    expect(deriveCallUiState({ ...base })).toBe("ringing");
  });

  it("never shows 'calling' once the partner has been connected or audio is live", () => {
    expect(deriveCallUiState({ ...base, everConnected: true, direction: "outgoing", peerRinging: false })).toBe("partner-left");
    expect(deriveCallUiState({ ...base, participantCount: 2, remoteAudioReady: true, direction: "outgoing", peerRinging: false })).toBe("connected");
  });

  it("incoming side is unaffected by peerRinging", () => {
    expect(deriveCallUiState({ ...base, callState: "joining", direction: "incoming", peerRinging: false })).toBe("connected");
  });

  it("has a label", () => {
    expect(CALL_UI_STATE_LABEL.calling).toBe("Calling…");
    expect(CALL_UI_STATE_LABEL.ringing).toBe("Ringing…");
  });
});

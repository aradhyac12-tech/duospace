import { describe, it, expect } from "vitest";
import { isStageSurface } from "../lib/callChromeTone";

const base = { isVoiceCall: false, callUiState: "connected", remoteVideoOn: true, isScreenSharing: false };

describe("call chrome tone: which surface is behind the controls", () => {
  it("voice calls always sit on the themed stage", () => {
    for (const s of ["ringing", "calling", "connecting", "connected", "reconnecting"]) {
      expect(isStageSurface({ ...base, isVoiceCall: true, callUiState: s })).toBe(true);
    }
  });
  it("connected video with live remote video is the video surface (light chrome)", () => {
    expect(isStageSurface(base)).toBe(false);
    expect(isStageSurface({ ...base, callUiState: "reconnecting" })).toBe(false);
  });
  it("partner camera off on a video call falls back to the themed stage (theme foreground)", () => {
    expect(isStageSurface({ ...base, remoteVideoOn: false })).toBe(true);
    expect(isStageSurface({ ...base, remoteVideoOn: false, callUiState: "reconnecting" })).toBe(true);
  });
  it("screen share keeps the video surface even if the remote camera is off", () => {
    expect(isStageSurface({ ...base, remoteVideoOn: false, isScreenSharing: true })).toBe(false);
  });
  it("video connecting uses the stage; video ringing/calling is on the black video element", () => {
    expect(isStageSurface({ ...base, callUiState: "connecting" })).toBe(true);
    expect(isStageSurface({ ...base, callUiState: "ringing", remoteVideoOn: false })).toBe(false);
    expect(isStageSurface({ ...base, callUiState: "calling", remoteVideoOn: false })).toBe(false);
  });
});

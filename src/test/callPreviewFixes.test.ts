import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Static regression checks for the v3.22.43 call-preview pass (rendering CallStage needs the whole call provider stack). */
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("CallStage self-preview", () => {
  const src = read("src/components/calls/CallStage.tsx");
  it("flip button is routed through a one-at-a-time guard that calls cycleCamera", () => {
    expect(src).toMatch(/flipBusyRef\.current\) return/);
    expect(src).toMatch(/await cycleCamera\(\)/);
    expect(src).toMatch(/disabled=\{flipping\}/);
  });
  it("flip button only appears when the device has more than one camera", () => {
    expect(src).toMatch(/canFlipCamera = cameraCount !== null && cameraCount > 1/);
    expect(src).toMatch(/isVideoOn && canFlipCamera/);
  });
  it("tile sits below the header/badge rows and its drag bounds match", () => {
    const tops = src.match(/safe-area-inset-top, 0px\) \+ 104px/g) ?? [];
    expect(tops.length).toBeGreaterThanOrEqual(2); // tile style + drag bounds (+ full-screen flip button)
    expect(src).toMatch(/safe-area-inset-bottom, 0px\) \+ 140px/);
  });
  it("re-snaps on resize and orientation change and cleans up", () => {
    expect(src).toMatch(/addEventListener\("orientationchange", onResize\)/);
    expect(src).toMatch(/removeEventListener\("orientationchange", onResize\)/);
    expect(src).toMatch(/cancelAnimationFrame\(raf\)/);
  });
  it("outgoing video ringing shows an already-running camera full screen, and never starts one", () => {
    expect(src).toMatch(/ringingPreview = !isVoiceCall && \(callUiState === "ringing" \|\| callUiState === "calling"\) && isVideoOn/);
    expect(src).not.toMatch(/ringingPreview[^\n]*toggleVideo/);
  });
  it("connected voice call header no longer repeats the name and timer", () => {
    expect(src).toMatch(/voiceConnected = isVoiceCall && \(callUiState === "connected" \|\| callUiState === "reconnecting"\)/);
    expect(src).toMatch(/!voiceConnected && <p/);
  });
  it("resolution badge is only shown once connected", () => {
    expect(src).toMatch(/!isVoiceCall && \(callUiState === "connected" \|\| callUiState === "reconnecting"\) && \(/);
  });
});

describe("MinimizedCallBubble", () => {
  const src = read("src/components/calls/MinimizedCallBubble.tsx");
  it("shows the partner's video based on remoteVideoOn, not your own camera", () => {
    expect(src).toMatch(/remoteVideoOn && !isScreenSharing \?/);
    expect(src).not.toMatch(/isVideoOn/);
  });
  it("re-attaches the partner's track when its video element mounts", () => {
    expect(src).toMatch(/if \(showRemoteVideo\) reattachRemoteVideo\(\)/);
  });
  it("re-snaps on rotation", () => {
    expect(src).toMatch(/orientationchange/);
  });
});

describe("IncomingCallOverlay keyboard", () => {
  const src = read("src/components/IncomingCallOverlay.tsx");
  it("Enter does not answer when a button (e.g. the focused Decline) has focus", () => {
    expect(src).toMatch(/el\.closest\("button, a, input, textarea, select, \[role='button'\]"\)\) return/);
  });
});

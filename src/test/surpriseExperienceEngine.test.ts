/**
 * Tests for src/lib/surpriseExperienceEngine.ts — the single dispatch
 * point's idempotency guard is the one property §12/§14 explicitly ask
 * for ("no allow reconnects or realtime duplication to replay major
 * haptic sequences"), so it's the thing worth locking down with a test
 * rather than only a code comment.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const content = { html_content: "<div>hi</div>", css_content: "", js_content: "" };

let playCapabilityAwareSequence: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  playCapabilityAwareSequence = vi.fn(() => () => {});
  vi.doMock("@/lib/surpriseCapabilities", () => ({ playCapabilityAwareSequence }));
});

describe("SurpriseExperienceEngine.dispatch", () => {
  it("MAJOR_REVEAL only ever fires its haptic once per surprise, even dispatched repeatedly", async () => {
    const { SurpriseExperienceEngine } = await import("@/lib/surpriseExperienceEngine");
    SurpriseExperienceEngine.dispatch("s1", "MAJOR_REVEAL", content);
    SurpriseExperienceEngine.dispatch("s1", "MAJOR_REVEAL", content); // remount/reconnect replay
    SurpriseExperienceEngine.dispatch("s1", "MAJOR_REVEAL", content); // duplicate realtime tick
    expect(playCapabilityAwareSequence).toHaveBeenCalledTimes(1);
  });

  it("COMPLETE only ever fires once per surprise too", async () => {
    const { SurpriseExperienceEngine } = await import("@/lib/surpriseExperienceEngine");
    SurpriseExperienceEngine.dispatch("s2", "COMPLETE", content);
    SurpriseExperienceEngine.dispatch("s2", "COMPLETE", content);
    expect(playCapabilityAwareSequence).toHaveBeenCalledTimes(1);
  });

  it("MAJOR_REVEAL and COMPLETE are tracked independently — one firing doesn't block the other", async () => {
    const { SurpriseExperienceEngine } = await import("@/lib/surpriseExperienceEngine");
    SurpriseExperienceEngine.dispatch("s3", "MAJOR_REVEAL", content);
    SurpriseExperienceEngine.dispatch("s3", "COMPLETE", content);
    expect(playCapabilityAwareSequence).toHaveBeenCalledTimes(2);
  });

  it("the once-guard is per-surprise, not global", async () => {
    const { SurpriseExperienceEngine } = await import("@/lib/surpriseExperienceEngine");
    SurpriseExperienceEngine.dispatch("s4", "MAJOR_REVEAL", content);
    SurpriseExperienceEngine.dispatch("s5", "MAJOR_REVEAL", content);
    expect(playCapabilityAwareSequence).toHaveBeenCalledTimes(2);
  });

  it("RECEIVE/MATERIALIZE/OPEN/INTERACT/CLOSE are legitimately repeatable", async () => {
    const { SurpriseExperienceEngine } = await import("@/lib/surpriseExperienceEngine");
    for (const event of ["RECEIVE", "MATERIALIZE", "OPEN", "INTERACT", "CLOSE"] as const) {
      SurpriseExperienceEngine.dispatch("s6", event, content);
      SurpriseExperienceEngine.dispatch("s6", event, content);
    }
    expect(playCapabilityAwareSequence).toHaveBeenCalledTimes(10);
  });

  it("PARTNER_REACTION notifies listeners but fires no local haptic of its own yet", async () => {
    const { SurpriseExperienceEngine } = await import("@/lib/surpriseExperienceEngine");
    const heard: string[] = [];
    SurpriseExperienceEngine.subscribe("s7", (event) => heard.push(event));
    SurpriseExperienceEngine.dispatch("s7", "PARTNER_REACTION", content);
    expect(playCapabilityAwareSequence).not.toHaveBeenCalled();
    expect(heard).toEqual(["PARTNER_REACTION"]);
  });

  it("release() clears fired-once state, so re-dispatching after release fires again (a fresh open, not a replay)", async () => {
    const { SurpriseExperienceEngine } = await import("@/lib/surpriseExperienceEngine");
    SurpriseExperienceEngine.dispatch("s8", "MAJOR_REVEAL", content);
    SurpriseExperienceEngine.release("s8");
    SurpriseExperienceEngine.dispatch("s8", "MAJOR_REVEAL", content);
    expect(playCapabilityAwareSequence).toHaveBeenCalledTimes(2);
  });

  it("subscribe/unsubscribe: the returned function stops further notifications", async () => {
    const { SurpriseExperienceEngine } = await import("@/lib/surpriseExperienceEngine");
    const heard: string[] = [];
    const unsubscribe = SurpriseExperienceEngine.subscribe("s9", (event) => heard.push(event));
    SurpriseExperienceEngine.dispatch("s9", "RECEIVE", content);
    unsubscribe();
    SurpriseExperienceEngine.dispatch("s9", "MATERIALIZE", content);
    expect(heard).toEqual(["RECEIVE"]);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { RECEIVER_PARTICIPANT_TIMEOUT_MS, CALLER_PARTICIPANT_TIMEOUT_MS } from "@/lib/callEngine/awaitCallMedia";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..");
const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), "utf-8");

/**
 * "Stuck on Connecting after pickup / takes too long" regression guards.
 * SOURCE-LEVEL invariants (same style as callHistoryProviderField.test.ts): the call
 * flows live in large page components with no render harness, so these pin the
 * ORDER that fixed the bug rather than behaviour.
 *
 *  1. CALLER joins LiveKit in parallel with the ring: joinCall() must be started
 *     BEFORE `await offerPromise`, never after it.
 *  2. CALLEE joins LiveKit in parallel with CALL_ACCEPTED (Promise.all of the two steps).
 *  3. The callee waits long enough for a slow caller (was 10s → "partner couldn't join").
 *  4. A cancelled/wedged attempt releases the start lock (Calls.tsx) and is retired
 *     per-attempt so it can't touch a newer attempt.
 */
describe.each(["src/pages/Calls.tsx", "src/pages/Chat.tsx"])("%s outgoing call order", (rel) => {
  const src = read(rel);
  it("starts the media join before awaiting the offer ack", () => {
    const joinStart = src.indexOf("const joinPromise = joinCall(");
    const offerWait = src.indexOf("await offerPromise");
    expect(joinStart).toBeGreaterThan(-1);
    expect(offerWait).toBeGreaterThan(joinStart);
    // and never serially after the offer any more
    expect(/await joinCall\(room\.roomId/.test(src)).toBe(false);
  });
  it("prefetches the livekit token as soon as the call row exists", () => {
    expect(src.indexOf("prefetchToken(room.roomId)")).toBeGreaterThan(-1);
    expect(src.indexOf("prefetchToken(room.roomId)")).toBeLessThan(src.indexOf("const joinPromise = joinCall("));
  });
  it("bounds the call_history insert", () => {
    expect(src).toMatch(/withTimeout\(supabase\.from\("call_history"\)\.insert\(/);
  });
  it("retires a cancelled attempt per-attempt", () => {
    expect(src).toContain("startAttemptRef.current += 1");
    expect(src).toContain("const isCancelled = () =>");
  });
});

describe("Calls.tsx start lock recovery", () => {
  const src = read("src/pages/Calls.tsx");
  it("cancelStartingCall releases startCallLockRef", () => {
    const body = src.slice(src.indexOf("const cancelStartingCall = () =>"));
    expect(body.slice(0, 900)).toContain("startCallLockRef.current = false");
  });
});

describe("CallContext accept order", () => {
  const src = read("src/contexts/CallContext.tsx");
  it("runs signaling accept and the media join together", () => {
    expect(src).toContain("Promise.all([signalingStep, joinStep])");
  });
  it("Cancel while accepting tears a claimed call down immediately", () => {
    expect(src).toContain("abandonNowRef");
  });
});

describe("participant wait bounds", () => {
  it("callee waits long enough for a slow caller (>= 30s) and never longer than the caller's own wait", () => {
    expect(RECEIVER_PARTICIPANT_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    expect(RECEIVER_PARTICIPANT_TIMEOUT_MS).toBeLessThanOrEqual(CALLER_PARTICIPANT_TIMEOUT_MS);
  });
});

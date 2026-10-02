/**
 * Regression: the readiness wait was SHORTER than one transport attempt
 * (accept 8s / default 5s vs a 10s per-attempt connect timeout), so a
 * slow-but-working network (phone just woken by the ring push) failed with
 * "Couldn't reach the calling service (CONNECT_TIMEOUT)" before the first
 * attempt could finish, and never got a retry.
 */
import { describe, it, expect } from "vitest";
import { CallSignalingClient, MIN_READY_WAIT_MS } from "@/lib/signalingEngine/CallSignalingClient";
import { SIGNALING_ACCEPT_READY_TIMEOUT_MS } from "@/contexts/CallContext";
import { World, ALICE } from "./helpers/world";

const PER_ATTEMPT_CONNECT_TIMEOUT_MS = 10_000; // WebSocketSignalingEngine CONNECT_TIMEOUT_MS

function clientRecordingWait() {
  const waits: number[] = [];
  const w = new World();
  const real = w.transport(ALICE);
  const orig = real.connect.bind(real);
  (real as unknown as { connect: (ms: number) => Promise<void> }).connect = (ms: number) => { waits.push(ms); return orig(); };
  real.disconnect?.();
  const c = new CallSignalingClient({ userId: ALICE, configured: true, createTransport: () => real });
  return { c, waits };
}

describe("signaling readiness waits long enough for a real attempt", () => {
  it("a short requested wait is raised to at least one full attempt + margin", async () => {
    const { c, waits } = clientRecordingWait();
    expect((await c.ensureReady({ timeoutMs: 500 })).ready).toBe(true);
    expect(waits[0]).toBeGreaterThan(PER_ATTEMPT_CONNECT_TIMEOUT_MS);
    expect(waits[0]).toBe(MIN_READY_WAIT_MS);
  });
  it("the default wait (outgoing calls) also covers a full attempt", async () => {
    const { c, waits } = clientRecordingWait();
    await c.ensureReady();
    expect(waits[0]).toBeGreaterThan(PER_ATTEMPT_CONNECT_TIMEOUT_MS);
  });
  it("a longer requested wait is kept as-is", async () => {
    const { c, waits } = clientRecordingWait();
    await c.ensureReady({ timeoutMs: 20_000 });
    expect(waits[0]).toBe(20_000);
  });
  it("accepting an incoming call allows two attempts, inside the 60s accept watchdog", () => {
    expect(SIGNALING_ACCEPT_READY_TIMEOUT_MS).toBeGreaterThanOrEqual(2 * PER_ATTEMPT_CONNECT_TIMEOUT_MS);
    expect(SIGNALING_ACCEPT_READY_TIMEOUT_MS).toBeLessThan(60_000);
  });
});

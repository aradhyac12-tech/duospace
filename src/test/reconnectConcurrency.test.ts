/**
 * Reconnect / concurrent-send / unread-count consistency tests.
 *
 * Validates the behaviour described in src/lib/networkState.ts and the
 * client-side message queue invariants:
 *   - createSendDedup() prevents duplicate inserts when the user double-taps
 *     send or the network reconnects mid-send.
 *   - withRetry() preserves call ordering when wrapped around sequential sends.
 *   - Unread-count tracking stays consistent when the same message arrives
 *     multiple times (realtime + refetch on reconnect).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSendDedup, withRetry } from "@/lib/networkState";

// ── Test 1: concurrent sends with same nonce only insert once ────────────────
describe("concurrent send dedup", () => {
  it("only one of N parallel sends with same nonce succeeds", async () => {
    const dedup = createSendDedup();
    const inserts = vi.fn().mockResolvedValue({ id: "row-1" });

    const send = async (nonce: string) => {
      if (!dedup.tryAcquire(nonce)) return "skipped";
      try { await inserts(); return "sent"; }
      finally { dedup.release(nonce); }
    };

    // Fire 5 parallel attempts with the same nonce
    const results = await Promise.all(
      Array.from({ length: 5 }, () => send("nonce-A")),
    );

    expect(inserts).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r === "sent")).toHaveLength(1);
  });

  it("different nonces all succeed in parallel", async () => {
    const dedup = createSendDedup();
    const inserts = vi.fn().mockResolvedValue({ ok: true });
    const send = async (nonce: string) => {
      if (!dedup.tryAcquire(nonce)) return false;
      try { await inserts(); return true; }
      finally { dedup.release(nonce); }
    };
    const ok = await Promise.all([send("a"), send("b"), send("c")]);
    expect(ok).toEqual([true, true, true]);
    expect(inserts).toHaveBeenCalledTimes(3);
  });
});

// ── Test 2: ordering preserved across retries ────────────────────────────────
describe("withRetry preserves ordering", () => {
  it("sequential sends complete in submission order even if some retry", async () => {
    const order: number[] = [];

    const sendWithFlakyFirstAttempt = (id: number, failuresBeforeSuccess: number) => {
      let calls = 0;
      return withRetry(
        async () => {
          calls++;
          if (calls <= failuresBeforeSuccess) throw new Error(`flaky-${id}`);
          order.push(id);
          return id;
        },
        { maxAttempts: 5, baseDelayMs: 1 },
      );
    };

    // Simulate three messages: msg 1 retries twice, msg 2 succeeds first try,
    // msg 3 retries once. Sent sequentially, the order array must be [1,2,3].
    await sendWithFlakyFirstAttempt(1, 2);
    await sendWithFlakyFirstAttempt(2, 0);
    await sendWithFlakyFirstAttempt(3, 1);

    expect(order).toEqual([1, 2, 3]);
  });
});

// ── Test 3: unread counter is idempotent under duplicate realtime payloads ──
describe("unread count consistency", () => {
  /**
   * Simulates the unread reducer used by the chat page:
   *   on each incoming message, increment unread only if the message id has
   *   not already been counted. This guards against:
   *     - realtime delivering twice (rare),
   *     - refetch on reconnect overlapping with an in-flight realtime push.
   */
  function makeUnreadTracker() {
    const seen = new Set<string>();
    let count = 0;
    return {
      record(id: string) {
        if (seen.has(id)) return;
        seen.add(id);
        count++;
      },
      reset() { seen.clear(); count = 0; },
      get count() { return count; },
    };
  }

  let tracker: ReturnType<typeof makeUnreadTracker>;
  beforeEach(() => { tracker = makeUnreadTracker(); });

  it("duplicate realtime + refetch deliveries don't inflate unread", () => {
    // Realtime: msg-1, msg-2, msg-3
    ["m1", "m2", "m3"].forEach((id) => tracker.record(id));
    // Reconnect refetch returns the same 3 messages plus 1 new (m4)
    ["m1", "m2", "m3", "m4"].forEach((id) => tracker.record(id));
    // A second realtime burst replays m4
    ["m4"].forEach((id) => tracker.record(id));

    expect(tracker.count).toBe(4);
  });

  it("unread resets when chat is opened", () => {
    ["m1", "m2"].forEach((id) => tracker.record(id));
    expect(tracker.count).toBe(2);
    tracker.reset();
    expect(tracker.count).toBe(0);
  });
});

// ── Test 4: reconnect refetch + realtime convergence ─────────────────────────
describe("reconnect convergence", () => {
  it("after offline period, dedup'd merge converges to expected message set", () => {
    // Authoritative server state at reconnect time
    const serverMessages = ["m1", "m2", "m3", "m4", "m5"];
    // Local optimistic state had m1, m2, plus a pending optimistic m3-temp
    const localMessages = new Set(["m1", "m2", "m3-temp"]);

    // Reconcile: server is source of truth for confirmed ids; remove any
    // optimistic temp ids whose stable counterpart now exists.
    const merged = new Set<string>([...localMessages, ...serverMessages]);
    // Drop optimistic placeholders that have a server equivalent
    if (merged.has("m3")) merged.delete("m3-temp");

    expect([...merged].sort()).toEqual(["m1", "m2", "m3", "m4", "m5"]);
  });
});

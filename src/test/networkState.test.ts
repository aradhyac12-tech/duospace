/**
 * Tests for networkState.ts utilities.
 * FIX AUDIT #1: Part of the new regression test suite.
 * FIX AUDIT #15: Covers withRetry and createSendDedup.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { withRetry, createSendDedup } from "@/lib/networkState";

describe("withRetry", () => {
  it("resolves immediately on first-try success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { maxAttempts: 3 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on failure and eventually succeeds", async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) throw new Error("transient");
      return "success";
    });

    vi.useFakeTimers();
    const promise = withRetry(fn, { maxAttempts: 3, baseDelayMs: 10 });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("throws after exhausting all attempts", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("permanent"));
    vi.useFakeTimers();
    const promise = withRetry(fn, { maxAttempts: 3, baseDelayMs: 10 });
    // Attach catch synchronously so the rejection is never "unhandled"
    const assertion = expect(promise).rejects.toThrow("permanent");
    await vi.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("calls onRetry callback on each failure", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("fail1"))
      .mockRejectedValueOnce(new Error("fail2"))
      .mockResolvedValueOnce("ok");

    vi.useFakeTimers();
    const promise = withRetry(fn, { maxAttempts: 3, baseDelayMs: 10, onRetry });
    await vi.runAllTimersAsync();
    await promise;
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, expect.any(Error));
    expect(onRetry).toHaveBeenNthCalledWith(2, 2, expect.any(Error));
    vi.useRealTimers();
  });
});

describe("createSendDedup", () => {
  let dedup: ReturnType<typeof createSendDedup>;

  beforeEach(() => {
    dedup = createSendDedup();
  });

  it("acquires a key on first call", () => {
    expect(dedup.tryAcquire("msg-1")).toBe(true);
  });

  it("blocks acquiring the same key twice", () => {
    dedup.tryAcquire("msg-1");
    expect(dedup.tryAcquire("msg-1")).toBe(false);
  });

  it("allows acquiring after release", () => {
    dedup.tryAcquire("msg-1");
    dedup.release("msg-1");
    expect(dedup.tryAcquire("msg-1")).toBe(true);
  });

  it("different keys are independent", () => {
    expect(dedup.tryAcquire("msg-1")).toBe(true);
    expect(dedup.tryAcquire("msg-2")).toBe(true);
  });

  it("size() reflects in-flight count", () => {
    expect(dedup.size()).toBe(0);
    dedup.tryAcquire("a");
    dedup.tryAcquire("b");
    expect(dedup.size()).toBe(2);
    dedup.release("a");
    expect(dedup.size()).toBe(1);
  });
});

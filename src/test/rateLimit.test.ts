/**
 * Tests for rateLimit.ts
 * FIX AUDIT #1: Part of the new regression test suite.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createRateLimiter,
  formatRetryDelay,
  callRoomLimiter,
  emailLimiter,
  searchLimiter,
} from "@/lib/rateLimit";

describe("createRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows calls within the limit", () => {
    const limiter = createRateLimiter("test-allow", { maxCalls: 3, windowMs: 1000 });
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(true);
  });

  it("blocks calls that exceed the limit", () => {
    const limiter = createRateLimiter("test-block", { maxCalls: 2, windowMs: 1000 });
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(false); // 3rd call blocked
  });

  it("allows again after the window expires", () => {
    const limiter = createRateLimiter("test-window", { maxCalls: 1, windowMs: 1000 });
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(false); // blocked
    vi.advanceTimersByTime(1001);
    expect(limiter.allow()).toBe(true); // window expired, allowed again
  });

  it("remaining() reports correct count", () => {
    const limiter = createRateLimiter("test-remaining", { maxCalls: 3, windowMs: 5000 });
    expect(limiter.remaining()).toBe(3);
    limiter.allow();
    expect(limiter.remaining()).toBe(2);
    limiter.allow();
    expect(limiter.remaining()).toBe(1);
    limiter.allow();
    expect(limiter.remaining()).toBe(0);
  });

  it("retryAfterMs() returns 0 when not limited", () => {
    const limiter = createRateLimiter("test-retry-free", { maxCalls: 5, windowMs: 1000 });
    expect(limiter.retryAfterMs()).toBe(0);
  });

  it("retryAfterMs() returns positive value when limited", () => {
    const limiter = createRateLimiter("test-retry-limited", { maxCalls: 1, windowMs: 5000 });
    limiter.allow(); // use up the allowance
    limiter.allow(); // blocked — now limited
    expect(limiter.retryAfterMs()).toBeGreaterThan(0);
    expect(limiter.retryAfterMs()).toBeLessThanOrEqual(5000);
  });
});

describe("formatRetryDelay", () => {
  it("returns 'now' for 0ms", () => {
    expect(formatRetryDelay(0)).toBe("now");
  });

  it("formats seconds correctly", () => {
    expect(formatRetryDelay(45_000)).toBe("45 seconds");
  });

  it("formats 1 second correctly", () => {
    expect(formatRetryDelay(1_000)).toBe("1 second");
  });

  it("formats minutes correctly", () => {
    expect(formatRetryDelay(120_000)).toBe("2 minutes");
  });

  it("formats 1 minute correctly", () => {
    expect(formatRetryDelay(60_000)).toBe("1 minute");
  });
});

describe("pre-built limiters exist and are configured", () => {
  it("callRoomLimiter exists", () => {
    expect(callRoomLimiter).toBeDefined();
    expect(typeof callRoomLimiter.allow).toBe("function");
  });

  it("emailLimiter exists", () => {
    expect(emailLimiter).toBeDefined();
    expect(typeof emailLimiter.allow).toBe("function");
  });

  it("searchLimiter exists", () => {
    expect(searchLimiter).toBeDefined();
    expect(typeof searchLimiter.allow).toBe("function");
  });
});

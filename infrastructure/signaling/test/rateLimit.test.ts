import { describe, it, expect, afterEach } from "vitest";
import { RateLimiter } from "../src/rateLimit.js";

describe("RateLimiter", () => {
  let limiter: RateLimiter | null = null;
  afterEach(() => { limiter?.dispose(); limiter = null; });

  it("allows attempts up to the limit within the window", () => {
    limiter = new RateLimiter(3, 10_000);
    expect(limiter.check("user-1")).toBe(true);
    expect(limiter.check("user-1")).toBe(true);
    expect(limiter.check("user-1")).toBe(true);
  });

  it("blocks once the limit is exceeded within the window", () => {
    limiter = new RateLimiter(3, 10_000);
    limiter.check("user-1"); limiter.check("user-1"); limiter.check("user-1");
    expect(limiter.check("user-1")).toBe(false);
  });

  it("tracks separate keys independently", () => {
    limiter = new RateLimiter(1, 10_000);
    expect(limiter.check("user-1")).toBe(true);
    expect(limiter.check("user-2")).toBe(true);
    expect(limiter.check("user-1")).toBe(false);
    expect(limiter.check("user-2")).toBe(false);
  });

  it("resets after the window elapses", async () => {
    limiter = new RateLimiter(1, 20);
    expect(limiter.check("user-1")).toBe(true);
    expect(limiter.check("user-1")).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(limiter.check("user-1")).toBe(true);
  });
});

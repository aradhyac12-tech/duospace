/**
 * rateLimit — bounded in-memory sliding-window rate limiter (P1-10).
 *
 * SINGLE-INSTANCE ONLY. This is a plain in-process Map — it has no
 * shared state across multiple signaling server instances, so it does
 * nothing useful the moment this service is horizontally scaled beyond
 * one process. That's an explicit, documented limitation per the
 * remediation brief's own instruction ("a bounded in-memory mechanism is
 * acceptable if clearly documented as unsuitable for multi-instance
 * production deployment... If Redis is required later, document it
 * instead of introducing it unnecessarily now"). When this service is
 * ever deployed as more than one instance, replace this with a shared
 * store (Redis INCR+EXPIRE is the standard shape) — do not silently keep
 * this implementation and assume it still works.
 *
 * Bounded: userBuckets is periodically swept so idle users' entries
 * don't accumulate forever in memory across a long-running process.
 */

interface Bucket {
  count: number;
  windowStartMs: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private sweepTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    sweepIntervalMs = 60_000,
  ) {
    this.sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
    // Don't hold the process open just for this timer in tests/scripts.
    this.sweepTimer.unref?.();
  }

  /** Returns true if `key` is currently allowed to act; also records
   *  this attempt toward the limit regardless of the result, so repeated
   *  calls during a block still count (prevents a caller from probing
   *  around the limit for free). */
  check(key: string): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStartMs >= this.windowMs) {
      this.buckets.set(key, { count: 1, windowStartMs: now });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= this.limit;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStartMs >= this.windowMs) this.buckets.delete(key);
    }
  }

  /** Test/shutdown hook — not used by server.ts's own lifecycle (the
   *  process exiting is what actually stops it in production), but keeps
   *  a unit test from needing to wait out real timers or leak handles. */
  dispose(): void {
    clearInterval(this.sweepTimer);
  }
}

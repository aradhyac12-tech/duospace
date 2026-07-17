/**
 * Client-side rate limiter.
 *
 * FIX AUDIT #6: Prevents abuse of expensive operations:
 *  - room creation (calls)
 *  - email sending
 *  - search API
 *  - scheduled job submissions
 *
 * Uses a sliding-window token-bucket approach per key, stored in memory.
 * For server-side enforcement, pair this with the Supabase Edge Function
 * rate-limit headers or a Redis-backed limiter.
 *
 * Usage:
 *   const limiter = createRateLimiter("create-room", { maxCalls: 2, windowMs: 60_000 });
 *   if (!limiter.allow()) {
 *     toast({ title: "Please wait before starting another call" });
 *     return;
 *   }
 */

interface RateLimiterOptions {
  /** Maximum number of calls allowed within windowMs */
  maxCalls: number;
  /** Window size in milliseconds */
  windowMs: number;
}

interface RateLimiterState {
  timestamps: number[];
}

// In-memory store keyed by limiter name
const store = new Map<string, RateLimiterState>();

export interface RateLimiter {
  /** Returns true if the call is allowed, false if rate-limited */
  allow(): boolean;
  /** How many calls remain in the current window */
  remaining(): number;
  /** Milliseconds until the oldest call expires (0 if not limited) */
  retryAfterMs(): number;
}

export function createRateLimiter(key: string, opts: RateLimiterOptions): RateLimiter {
  return {
    allow(): boolean {
      const now = Date.now();
      if (!store.has(key)) store.set(key, { timestamps: [] });
      const state = store.get(key)!;
      // Evict entries outside the window
      state.timestamps = state.timestamps.filter(t => now - t < opts.windowMs);
      if (state.timestamps.length >= opts.maxCalls) return false;
      state.timestamps.push(now);
      return true;
    },
    remaining(): number {
      const now = Date.now();
      const state = store.get(key);
      if (!state) return opts.maxCalls;
      const active = state.timestamps.filter(t => now - t < opts.windowMs).length;
      return Math.max(0, opts.maxCalls - active);
    },
    retryAfterMs(): number {
      const now = Date.now();
      const state = store.get(key);
      if (!state || state.timestamps.length < opts.maxCalls) return 0;
      const oldest = state.timestamps
        .filter(t => now - t < opts.windowMs)
        .sort((a, b) => a - b)[0];
      if (oldest === undefined) return 0;
      return Math.max(0, oldest + opts.windowMs - now);
    },
  };
}

// ─── Pre-built limiters for common DuoSpace operations ────────────────────────

/** Max 2 call-room creations per minute */
export const callRoomLimiter = createRateLimiter("call-room", {
  maxCalls: 2,
  windowMs: 60_000,
});

/** Max 3 emails per 5 minutes */
export const emailLimiter = createRateLimiter("email", {
  maxCalls: 3,
  windowMs: 5 * 60_000,
});

/** Max 20 search queries per minute */
export const searchLimiter = createRateLimiter("search", {
  maxCalls: 20,
  windowMs: 60_000,
});

/** Max 5 scheduled message submissions per minute */
export const scheduledMsgLimiter = createRateLimiter("scheduled-msg", {
  maxCalls: 5,
  windowMs: 60_000,
});

/** Max 3 backup-restore operations per hour */
export const backupLimiter = createRateLimiter("backup", {
  maxCalls: 3,
  windowMs: 60 * 60_000,
});

/** Formats retry delay as human-readable string (e.g. "45 seconds") */
export function formatRetryDelay(ms: number): string {
  if (ms <= 0) return "now";
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s} second${s === 1 ? "" : "s"}`;
  const m = Math.ceil(s / 60);
  return `${m} minute${m === 1 ? "" : "s"}`;
}

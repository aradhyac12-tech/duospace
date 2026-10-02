/**
 * Network state management and exponential-backoff retry.
 *
 * FIX AUDIT #15: Handles duplicate sends, reconnect loops, spinner-forever states.
 * FIX AUDIT #16: Handles background/foreground app lifecycle via visibilitychange.
 *
 * Usage:
 *   import { useNetworkState } from "@/lib/networkState";
 *   const { isOnline, wasOffline } = useNetworkState();
 *   // Show an offline banner when !isOnline
 *   // wasOffline transitions true→false when connectivity is restored — trigger a refetch
 */

import { useState, useEffect, useCallback } from "react";
import { logInfo, logWarn } from "@/lib/telemetry";

// ─── Network hook ─────────────────────────────────────────────────────────────

export function useNetworkState() {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [wasOffline, setWasOffline] = useState(false);

  useEffect(() => {
    const onOnline = () => {
      logInfo("network", "connection restored");
      setIsOnline(true);
      setWasOffline(true);
      // Reset flag after one render cycle so consumers can react once
      setTimeout(() => setWasOffline(false), 0);
    };
    const onOffline = () => {
      logWarn("network", "connection lost");
      setIsOnline(false);
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  return { isOnline, wasOffline };
}

// ─── App visibility / lifecycle hook ─────────────────────────────────────────

/**
 * FIX AUDIT #16: Detects when the app resumes from background.
 * Returns `justResumed` = true for one tick when the page becomes visible again.
 * Use this to reconnect WebRTC, re-subscribe Supabase channels, or re-fetch data.
 */
export function useAppLifecycle() {
  const [justResumed, setJustResumed] = useState(false);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        logInfo("lifecycle", "app foregrounded");
        setJustResumed(true);
        setTimeout(() => setJustResumed(false), 0);
      } else {
        logInfo("lifecycle", "app backgrounded");
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  return { justResumed };
}

// ─── Exponential-backoff retry ────────────────────────────────────────────────

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Called on each failure before retry */
  onRetry?: (attempt: number, err: unknown) => void;
}

/**
 * Runs `fn` with exponential backoff.
 * Doubles the delay on each failure up to maxDelayMs.
 * Throws the last error if all attempts are exhausted.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 500,
    maxDelayMs = 8_000,
    onRetry,
  } = opts;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
        logWarn("withRetry", `attempt ${attempt} failed, retrying in ${delay}ms`, err);
        onRetry?.(attempt, err);
        await new Promise<void>(res => setTimeout(res, delay));
      }
    }
  }
  throw lastErr;
}

// ─── Deduplication guard (prevent duplicate sends) ───────────────────────────

/**
 * FIX AUDIT #15: Prevents duplicate message sends caused by rapid double-taps
 * or concurrent send attempts while offline.
 *
 * Usage:
 *   const dedup = createSendDedup();
 *   if (!dedup.tryAcquire(messageNonce)) return; // already sending
 *   try { await sendMessage(...); } finally { dedup.release(messageNonce); }
 */
export function createSendDedup() {
  const inFlight = new Set<string>();
  return {
    tryAcquire(key: string): boolean {
      if (inFlight.has(key)) return false;
      inFlight.add(key);
      return true;
    },
    release(key: string): void {
      inFlight.delete(key);
    },
    size(): number {
      return inFlight.size;
    },
  };
}

// ─── useReconnectRefetch hook ─────────────────────────────────────────────────

/**
 * Calls `refetch` whenever the app comes back online or resumes from background.
 * Debounces to avoid multiple rapid refetches.
 */
export function useReconnectRefetch(refetch: () => void) {
  const { wasOffline } = useNetworkState();
  const { justResumed } = useAppLifecycle();

  const debouncedRefetch = useCallback(() => {
    const id = setTimeout(refetch, 300);
    return () => clearTimeout(id);
  }, [refetch]);

  useEffect(() => {
    if (wasOffline) debouncedRefetch();
  }, [wasOffline, debouncedRefetch]);

  useEffect(() => {
    if (justResumed) debouncedRefetch();
  }, [justResumed, debouncedRefetch]);
}

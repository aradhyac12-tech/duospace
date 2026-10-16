/**
 * useRecoverableCall — finds a call that is STILL LIVE on the server but that
 * this device isn't in (app was killed/crashed, the room dropped, the notification
 * was dismissed, the person navigated away or minimised and lost track).
 *
 * Source of truth is call_history, never the local marker alone. A call is
 * recoverable when it is `in_progress`, not ended, and either
 *   - "connected": the receiver has claimed it (it was answered) and it is recent, or
 *   - "calling":   we are the caller and it is still inside its ring window.
 * Re-checked on mount, on foreground, on any call_history change for this
 * user, after every local call-state change, and every 10s while one is shown
 * (so the banner disappears by itself once the other side ends it).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/appClient";
import { uniqueChannelName } from "@/lib/realtimeChannel";

export interface RecoverableCall {
  callId: string;
  kind: "connected" | "calling";
  callType: "voice" | "video";
  direction: "incoming" | "outgoing";
  startedAt: number;
}

const MAX_LIVE_AGE_MS = 30 * 60_000; // same bound as callSessionRecovery
const RING_WINDOW_MS = 45_000;

export function useRecoverableCall(opts: { userId: string | null; busy: boolean; refreshKey: string }) {
  const { userId, busy, refreshKey } = opts;
  const [call, setCall] = useState<RecoverableCall | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const refresh = useCallback(async () => {
    if (!userId) { setCall(null); return; }
    try {
      const since = new Date(Date.now() - MAX_LIVE_AGE_MS).toISOString();
      const { data } = await supabase.from("call_history")
        .select("id, caller_id, receiver_id, call_type, status, claimed_by, ended_at, started_at, provider")
        .or(`caller_id.eq.${userId},receiver_id.eq.${userId}`)
        .eq("status", "in_progress")
        .is("ended_at", null)
        .gte("started_at", since)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const row = data as {
        id: string; caller_id: string; receiver_id: string; call_type: string; status: string;
        claimed_by: string | null; ended_at: string | null; started_at: string; provider: string | null;
      } | null;
      if (!row || (row.provider && row.provider !== "self_hosted")) { setCall(null); return; }
      const startedAt = Date.parse(row.started_at);
      const iAmCaller = row.caller_id === userId;
      const answered = !!row.claimed_by;
      // >8s old: a call this device is still STARTING is younger than that
      // (joinCall begins within a few seconds), so this is a genuinely lost one.
      const age = Date.now() - startedAt;
      const ringing = !answered && iAmCaller && age > 8_000 && age < RING_WINDOW_MS;
      if (!answered && !ringing) { setCall(null); return; }
      setCall({
        callId: row.id,
        kind: answered ? "connected" : "calling",
        callType: row.call_type === "voice" ? "voice" : "video",
        direction: iAmCaller ? "outgoing" : "incoming",
        startedAt,
      });
    } catch { /* offline: keep whatever we showed last */ }
  }, [userId]);

  useEffect(() => { void refresh(); }, [refresh, refreshKey]);

  useEffect(() => {
    if (!userId) return;
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    // Unique topic per effect run (see realtimeChannel.ts): a reused, still-subscribed
    // channel makes `.on()` throw and used to take down the whole Calls screen.
    // Realtime is only a freshness hint here (10s poll + foreground refresh remain),
    // so a failure must never reach the ErrorBoundary.
    const mk = (col: "caller_id" | "receiver_id") => {
      try {
        return supabase
          .channel(uniqueChannelName(`recoverable-call:${col}:${userId}`))
          .on("postgres_changes", { event: "*", schema: "public", table: "call_history", filter: `${col}=eq.${userId}` }, () => { void refresh(); })
          .subscribe();
      } catch { return null; }
    };
    const a = mk("caller_id");
    const b = mk("receiver_id");
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      for (const ch of [a, b]) { if (ch) { try { void supabase.removeChannel(ch); } catch { /* already gone */ } } }
    };
  }, [userId, refresh]);

  // While one is on offer, keep re-verifying so a finished call disappears.
  const hasCall = !!call;
  useEffect(() => {
    if (!hasCall) return;
    const id = setInterval(() => { void refresh(); }, 10_000);
    return () => clearInterval(id);
  }, [hasCall, refresh]);

  // Never offer the call this device is already in / joining.
  return { call: busy ? null : call, refresh };
}

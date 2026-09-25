import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/appClient";
import type { CallEntry } from "@/types/chat";
import { secureGet, secureSet } from "@/lib/privacy/secureStorage";

/**
 * Fetches the caller/receiver call_history rows for this couple and keeps
 * them in sync via a `call_history` realtime channel, refetching the full
 * ordered list on any change (insert on call start, updates on
 * status/ended_at/duration as the call progresses/ends).
 *
 * Extracted out of Chat.tsx's "Call history" effect (Phase-2
 * internal-architecture pass) — query shape, event handling, and cleanup
 * are unchanged, so behavior is identical.
 *
 * ONE FIX made during extraction (§7 subscription audit — duplicate
 * channel risk, not a behavior change): the channel name was the static
 * literal "call-history-rt" shared by every mounted instance of this
 * effect app-wide, instead of being scoped per couple like every other
 * channel in Chat.tsx (`typing-${...}`, `presence-${...}`, etc). The
 * fetch query itself was always correctly scoped by user/partnerId, so
 * this was never a data-leak — just an unnecessary global collision
 * surface (two tabs/instances would both attach handlers to the same
 * channel name). Scoped it to match the established convention.
 */
export function useCallHistory(user: { id: string } | null | undefined, partnerId: string | null) {
  const [callHistory, setCallHistory] = useState<CallEntry[]>([]);

  useEffect(() => {
    if (!user || !partnerId) return;
    let cancelled = false;
    const cacheKey = `chat-call-entries-v1-${partnerId}`;
    // OFFLINE-FIRST (2026-09-21): show the last known call rows immediately
    // (and offline) instead of an empty timeline until the network answers.
    // Call METADATA only (direction/status/duration) — `room_name` is dropped,
    // a cached row is display-only and never used to join anything. Stored
    // through secureStorage (encrypted at rest, wiped on sign-out).
    void secureGet<CallEntry[]>(user.id, cacheKey).then((cached) => {
      if (!cancelled && Array.isArray(cached) && cached.length > 0) {
        setCallHistory((prev) => (prev.length > 0 ? prev : cached));
      }
    });
    const fetchCalls = async () => {
      const { data } = await supabase.from("call_history").select("id,caller_id,receiver_id,room_name,call_type,call_direction,status,started_at,ended_at,duration_seconds,declined_at,created_at")
        .or(`and(caller_id.eq.${user.id},receiver_id.eq.${partnerId}),and(caller_id.eq.${partnerId},receiver_id.eq.${user.id})`)
        .order("created_at",{ ascending:true }).limit(200);
      if (data && !cancelled) {
        setCallHistory(data as CallEntry[]);
        const slim = (data as Array<CallEntry & { room_name?: unknown }>)
          .slice(-200)
          .map(({ room_name: _room, ...rest }) => rest);
        void secureSet(user.id, cacheKey, slim).catch(() => { /* best-effort */ });
      }
    };
    fetchCalls();
    const ch = supabase.channel(`call-history-rt-${[user.id, partnerId].sort().join("-")}`)
      .on("postgres_changes",{ event:"*",schema:"public",table:"call_history" },() => fetchCalls())
      .subscribe();
    return () => { cancelled = true; supabase.removeChannel(ch); };
  }, [user, partnerId]);

  return { callHistory };
}

import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/appClient";
import type { CallEntry } from "@/types/chat";

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
    const fetchCalls = async () => {
      const { data } = await supabase.from("call_history").select("id,caller_id,receiver_id,room_name,call_type,call_direction,status,started_at,ended_at,duration_seconds,created_at")
        .or(`and(caller_id.eq.${user.id},receiver_id.eq.${partnerId}),and(caller_id.eq.${partnerId},receiver_id.eq.${user.id})`)
        .order("created_at",{ ascending:true }).limit(200);
      if (data) setCallHistory(data as CallEntry[]);
    };
    fetchCalls();
    const ch = supabase.channel(`call-history-rt-${[user.id, partnerId].sort().join("-")}`)
      .on("postgres_changes",{ event:"*",schema:"public",table:"call_history" },() => fetchCalls())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [user, partnerId]);

  return { callHistory };
}

import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/appClient";

/**
 * Owns the `presence-${pair}` channel and reports whether the partner is
 * currently online (tracked via Supabase Presence, keyed by user id).
 *
 * Extracted out of Chat.tsx (Phase-2 internal-architecture pass) —
 * channel name, presence key, and cleanup are unchanged. Note: this is
 * distinct from useActiveChatPresence (which heartbeats
 * `active_chat_presence` for the send-push skip-check) — that hook
 * answers "is this specific thread on screen right now", this one
 * answers "is the partner's app open at all".
 */
export function useChatPresence(user: { id: string } | null | undefined, partnerId: string | null) {
  const [partnerOnline, setPartnerOnline] = useState(false);

  useEffect(() => {
    if (!user || !partnerId) return;
    const ch = supabase.channel(`presence-${[user.id, partnerId].sort().join("-")}`, { config: { presence: { key: user.id } } })
      .on("presence", { event: "sync" }, () => { const s = ch.presenceState(); setPartnerOnline(!!s[partnerId]); })
      .on("presence", { event: "join" }, ({ key }) => { if (key === partnerId) setPartnerOnline(true); })
      .on("presence", { event: "leave" }, ({ key }) => { if (key === partnerId) setPartnerOnline(false); })
      .subscribe(async (status) => { if (status === "SUBSCRIBED") await ch.track({ online_at: new Date().toISOString() }); });
    return () => { supabase.removeChannel(ch); };
  }, [user, partnerId]);

  return { partnerOnline };
}

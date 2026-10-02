import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/appClient";

/**
 * Owns the `presence:<uid1>:<uid2>` channel and reports whether the
 * partner is currently online (tracked via Supabase Presence, keyed by
 * user id).
 *
 * SECURITY (2026-09-16, Realtime authorization audit — see
 * supabase/migrations/20260916150000_realtime_authorization_couple_channels.sql):
 * this channel is marked `private: true` and gated server-side by RLS on
 * realtime.messages, keyed off this exact topic format — do not change
 * the "presence:<uid1>:<uid2>" shape without updating that migration's
 * is_couple_realtime_topic_authorized() to match.
 *
 * Extracted out of Chat.tsx (Phase-2 internal-architecture pass) —
 * presence key and cleanup are unchanged; channel name format changed
 * from `presence-<uid1>-<uid2>` to `presence:<uid1>:<uid2>` as part of
 * the security fix above (colons can't appear inside a UUID, unlike
 * hyphens, so the new format is unambiguous to parse server-side). Note:
 * this is distinct from useActiveChatPresence (which heartbeats
 * `active_chat_presence` for the send-push skip-check) — that hook
 * answers "is this specific thread on screen right now", this one
 * answers "is the partner's app open at all".
 */
export function useChatPresence(user: { id: string } | null | undefined, partnerId: string | null) {
  const [partnerOnline, setPartnerOnline] = useState(false);

  useEffect(() => {
    if (!user || !partnerId) return;
    const ch = supabase.channel(`presence:${[user.id, partnerId].sort().join(":")}`, { config: { presence: { key: user.id }, private: true } })
      .on("presence", { event: "sync" }, () => { const s = ch.presenceState(); setPartnerOnline(!!s[partnerId]); })
      .on("presence", { event: "join" }, ({ key }) => { if (key === partnerId) setPartnerOnline(true); })
      .on("presence", { event: "leave" }, ({ key }) => { if (key === partnerId) setPartnerOnline(false); })
      .subscribe(async (status) => { if (status === "SUBSCRIBED") await ch.track({ online_at: new Date().toISOString() }); });
    return () => { supabase.removeChannel(ch); };
  }, [user, partnerId]);

  return { partnerOnline };
}

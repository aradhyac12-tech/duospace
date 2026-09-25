import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/appClient";

/**
 * Owns the `typing:<uid1>:<uid2>` broadcast channel: reports whether the
 * partner is currently typing (with the existing 2s auto-clear), and
 * exposes a throttled `broadcastTyping()` for this side to call on
 * composer input.
 *
 * SECURITY (2026-09-16, Realtime authorization audit — see
 * supabase/migrations/20260916150000_realtime_authorization_couple_channels.sql):
 * this channel is marked `private: true` and gated server-side by RLS on
 * realtime.messages, keyed off this exact topic format — do not change
 * the "typing:<uid1>:<uid2>" shape (colon-delimited, sorted pair) without
 * updating that migration's is_couple_realtime_topic_authorized() to
 * match, or the channel will silently stop working once the accompanying
 * "Allow public access" dashboard setting is disabled.
 *
 * Extracted out of Chat.tsx (Phase-2 internal-architecture pass) —
 * timings (2s typing-clear, 2s broadcast throttle) and cleanup are
 * unchanged; channel name format changed from `typing-<uid1>-<uid2>` to
 * `typing:<uid1>:<uid2>` as part of the security fix above (colons can't
 * appear inside a UUID, so the new format is unambiguous to parse
 * server-side — the old hyphen-joined format wasn't, since each UUID
 * already contains hyphens of its own).
 */
export function useChatTyping(user: { id: string } | null | undefined, partnerId: string | null) {
  const [partnerTyping, setPartnerTyping] = useState(false);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingRef = useRef<number>(0);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  useEffect(() => {
    if (!user || !partnerId) return;
    const name = [user.id, partnerId].sort().join(":");
    const ch = supabase.channel(`typing:${name}`, { config: { private: true } })
      .on("broadcast", { event: "typing" }, (payload) => {
        if (payload.payload?.user_id !== partnerId) return;
        setPartnerTyping(true);
        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = setTimeout(() => setPartnerTyping(false), 2000);
      }).subscribe();
    channelRef.current = ch;
    return () => { supabase.removeChannel(ch); if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current); };
  }, [user, partnerId]);

  const broadcastTyping = useCallback(() => {
    if (!channelRef.current || !user) return;
    const now = Date.now();
    if (now - lastTypingRef.current < 2000) return;
    lastTypingRef.current = now;
    channelRef.current.send({ type: "broadcast", event: "typing", payload: { user_id: user.id } });
  }, [user]);

  return { partnerTyping, broadcastTyping };
}

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Owns the `typing-${pair}` broadcast channel: reports whether the
 * partner is currently typing (with the existing 2s auto-clear), and
 * exposes a throttled `broadcastTyping()` for this side to call on
 * composer input.
 *
 * Extracted out of Chat.tsx (Phase-2 internal-architecture pass) —
 * timings (2s typing-clear, 2s broadcast throttle), channel name, and
 * cleanup are unchanged.
 */
export function useChatTyping(user: { id: string } | null | undefined, partnerId: string | null) {
  const [partnerTyping, setPartnerTyping] = useState(false);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingRef = useRef<number>(0);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  useEffect(() => {
    if (!user || !partnerId) return;
    const name = [user.id, partnerId].sort().join("-");
    const ch = supabase.channel(`typing-${name}`)
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

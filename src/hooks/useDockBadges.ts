import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

/**
 * Unread-message / missed-call badge counts for the Chat/Calls nav tabs.
 *
 * Extracted out of FloatingDock.tsx (Phase 5.5: Unified Bottom Surface) so
 * the exact same realtime-subscribed counts can be reused by
 * DuoSpaceBottomSurface's nav row on /chat and /calls, and by FloatingDock
 * itself on every other page — one subscription pair, not two independent
 * ones that could disagree or double-fetch. Behavior unchanged from the
 * original: split channels so an incoming message doesn't re-query missed
 * calls and vice versa, and the active tab's own count clears itself (and,
 * for calls, marks missed calls "seen") the moment its route is current.
 */
export function useDockBadges() {
  const location = useLocation();
  const { user } = useAuth();
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [missedCalls, setMissedCalls] = useState(0);

  useEffect(() => {
    if (!user) return;
    const fetchUnreadMessages = async () => {
      const { count } = await supabase.from("messages").select("*", { count: "exact", head: true })
        .eq("receiver_id", user.id).eq("is_read", false);
      setUnreadMessages(count || 0);
    };
    const fetchMissedCalls = async () => {
      const { count } = await supabase.from("call_history").select("*", { count: "exact", head: true })
        .eq("receiver_id", user.id).eq("status", "missed");
      setMissedCalls(count || 0);
    };
    fetchUnreadMessages();
    fetchMissedCalls();
    const ch1 = supabase.channel("dock-msgs")
      .on("postgres_changes", { event: "*", schema: "public", table: "messages", filter: `receiver_id=eq.${user.id}` }, fetchUnreadMessages)
      .subscribe();
    const ch2 = supabase.channel("dock-calls")
      .on("postgres_changes", { event: "*", schema: "public", table: "call_history", filter: `receiver_id=eq.${user.id}` }, fetchMissedCalls)
      .subscribe();
    return () => { supabase.removeChannel(ch1); supabase.removeChannel(ch2); };
  }, [user]);

  useEffect(() => {
    if (location.pathname === "/chat") setUnreadMessages(0);
    if (location.pathname === "/calls" && user) {
      setMissedCalls(0);
      supabase.from("call_history").update({ status: "seen" })
        .eq("receiver_id", user.id).eq("status", "missed").then(() => {});
    }
  }, [location.pathname, user]);

  return { unreadMessages, missedCalls };
}

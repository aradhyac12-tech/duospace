import { createContext, useContext, useEffect, useState, useMemo, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { supabase } from "@/integrations/supabase/appClient";
import { useAuth } from "@/hooks/useAuth";

/**
 * DockBadgesContext — unread-message / missed-call badge counts for the
 * Chat/Calls nav tabs.
 *
 * PERF/BUG FIX ("hub fluttering" — badge counts visibly flashing to 0 and
 * back on ordinary navigation): this logic used to live directly in the
 * useDockBadges hook, called straight from DockNavRow. That reads fine in
 * isolation, but DockNavRow itself is only ever mounted inside ONE of
 * FloatingDock / DuoSpaceBottomSurface at a time — AppLayout swaps between
 * them based on route (primary tabs Chat/Calls get DuoSpaceBottomSurface,
 * every other page gets FloatingDock; see AppLayout.tsx). That swap fully
 * unmounts one nav surface and mounts the other, so every single
 * navigation between a primary tab and any other page (Gallery, Map,
 * Settings, Us, ...) tore down useDockBadges' two realtime channels and
 * re-ran both COUNT queries from scratch — the badge would render 0 for a
 * frame (React's initial useState(0)) and then jump to the real count once
 * the fresh fetch resolved, on every tab switch, plus the repeated
 * subscribe/unsubscribe churn itself was wasted network/CPU work for data
 * that hadn't actually changed.
 *
 * Moved the whole thing up into a context provider mounted once at
 * AppLayout, above both nav surfaces and above the route swap entirely —
 * same pattern already used here for GroicProvider/BottomSurfaceProvider.
 * The subscriptions and their current counts now live for the lifetime of
 * the app shell, not the lifetime of whichever nav surface happens to be
 * on screen, so switching tabs just reads the already-current count
 * instead of refetching and re-flashing it.
 */

interface DockBadgesCtx {
  unreadMessages: number;
  missedCalls: number;
}

const DockBadgesContext = createContext<DockBadgesCtx>({ unreadMessages: 0, missedCalls: 0 });

export const DockBadgesProvider = ({ children }: { children: ReactNode }) => {
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

  const value = useMemo(() => ({ unreadMessages, missedCalls }), [unreadMessages, missedCalls]);

  return <DockBadgesContext.Provider value={value}>{children}</DockBadgesContext.Provider>;
};

/** Consumed by DockNavRow — same name/shape as the old standalone hook so
 *  call sites didn't need to change, just the import path. */
export function useDockBadges(): DockBadgesCtx {
  return useContext(DockBadgesContext);
}

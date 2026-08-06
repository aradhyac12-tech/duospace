import { useLocation, useNavigate } from "react-router-dom";
import { MessageCircle, Phone } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { routePreload } from "@/App";
import { hapticTick } from "@/lib/haptics";
// Dock nav is a "tab focus" interaction — hapticTick is the haptics system's
// own documented choice for that (see src/lib/haptics.ts), not a generic tap.
const triggerHaptic = (_kind?: string) => { hapticTick(); };

type Tab = {
  path: string;
  icon: typeof MessageCircle;
  label: string;
  badgeKey?: "messages" | "calls";
};

// Bottom bar is intentionally limited to exactly Chat + Calls. Settings now
// lives behind Profile (tap the partner name/avatar in the Chat header) —
// it's a secondary destination, not a primary tab. Everything else
// (Gallery, Us, Map, Music, Shayari, Love Letter, Schedule Send) lives in
// the in-chat sparkle "Hub" (GridMenu, opened from Chat.tsx).
const PRIMARY: Tab[] = [
  { path: "/chat", icon: MessageCircle, label: "Chat", badgeKey: "messages" },
  { path: "/calls", icon: Phone, label: "Calls", badgeKey: "calls" },
];

interface FloatingDockProps {
  /** Lifted up to AppLayout so its reserved bottom padding can animate in
   *  sync with the dock instead of leaving a static gap when it hides —
   *  see hooks/useDockVisibility.ts. */
  isVisible: boolean;
  isHidden: boolean;
}

const FloatingDock = ({ isVisible, isHidden }: FloatingDockProps) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [missedCalls, setMissedCalls] = useState(0);

  // ── Realtime badge counts ──────────────────────────────────────────────────
  useEffect(() => {
    if (!user) return;
    const fetchCounts = async () => {
      const [{ count: msg }, { count: call }] = await Promise.all([
        supabase.from("messages").select("*", { count: "exact", head: true })
          .eq("receiver_id", user.id).eq("is_read", false),
        supabase.from("call_history").select("*", { count: "exact", head: true })
          .eq("receiver_id", user.id).eq("status", "missed"),
      ]);
      setUnreadMessages(msg || 0);
      setMissedCalls(call || 0);
    };
    fetchCounts();
    const ch1 = supabase.channel("dock-msgs")
      .on("postgres_changes", { event: "*", schema: "public", table: "messages", filter: `receiver_id=eq.${user.id}` }, fetchCounts)
      .subscribe();
    const ch2 = supabase.channel("dock-calls")
      .on("postgres_changes", { event: "*", schema: "public", table: "call_history", filter: `receiver_id=eq.${user.id}` }, fetchCounts)
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

  if (isHidden) return null;

  const badgeFor = (key?: Tab["badgeKey"]) =>
    key === "messages" ? unreadMessages : key === "calls" ? missedCalls : 0;

  const go = (path: string) => {
    triggerHaptic("light");
    navigate(path);
  };

  const renderTab = (tab: Tab, opts?: { compact?: boolean }) => {
    const isActive = location.pathname === tab.path;
    const Icon = tab.icon;
    const count = badgeFor(tab.badgeKey);
    return (
      <button
        key={tab.path}
        onClick={() => go(tab.path)}
        onPointerDown={() => routePreload[tab.path]?.().catch(() => {})}
        aria-label={tab.label}
        aria-current={isActive ? "page" : undefined}
        className={cn(
          "relative flex items-center justify-center rounded-full transition-colors outline-none",
          "h-11 w-11 active:scale-95",
          isActive ? "text-primary" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {isActive && (
          <motion.span
            layoutId="dock-active-pill"
            className="absolute inset-0 rounded-full bg-primary/12 ring-1 ring-primary/15"
            style={{ boxShadow: "var(--shadow-soft)" }}
            transition={{ type: "spring", stiffness: 500, damping: 38 }}
          />
        )}
        <Icon
          className="relative z-10 h-[20px] w-[20px]"
          strokeWidth={isActive ? 2.2 : 1.8}
          fill={isActive ? "currentColor" : "none"}
          fillOpacity={isActive ? 0.12 : 0}
        />
        {count > 0 && (
          <span className="absolute top-1 right-1 z-20 h-4 min-w-4 px-1 rounded-full bg-destructive text-destructive-foreground text-[9px] font-bold flex items-center justify-center leading-none ring-2 ring-background">
            {count > 99 ? "99+" : count}
          </span>
        )}
        {opts?.compact === false && (
          <span className="sr-only">{tab.label}</span>
        )}
      </button>
    );
  };

  return (
    <motion.nav
      initial={false}
      animate={{ y: isVisible ? 0 : 120, opacity: isVisible ? 1 : 0 }}
      transition={{ type: "spring", stiffness: 380, damping: 34 }}
      className="fixed left-0 right-0 z-50 flex justify-center pointer-events-none"
      style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 14px)" }}
      aria-label="Primary"
    >
      <div
        className={cn(
          "pointer-events-auto flex items-center gap-2 px-2 py-1.5 rounded-full",
          "glass-dock",
        )}
      >

        {PRIMARY.map((t) => renderTab(t))}
      </div>
    </motion.nav>
  );
};

export default FloatingDock;

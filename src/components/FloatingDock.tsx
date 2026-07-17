import { useLocation, useNavigate } from "react-router-dom";
import { MessageCircle, Image, Phone, Heart, Settings, Music, MapPin, MoreHorizontal } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { useState, useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { routePreload } from "@/App";
import { hapticLight } from "@/lib/haptics";
const triggerHaptic = (_kind?: string) => { hapticLight(); };

type Tab = {
  path: string;
  icon: typeof MessageCircle;
  label: string;
  badgeKey?: "messages" | "calls";
};

// Primary tabs shown directly in the floating dock. Secondary tabs live in the
// expandable "More" sheet — keeps the dock pill-tight on small screens.
const PRIMARY: Tab[] = [
  { path: "/chat", icon: MessageCircle, label: "Chat", badgeKey: "messages" },
  { path: "/gallery", icon: Image, label: "Gallery" },
  { path: "/calls", icon: Phone, label: "Calls", badgeKey: "calls" },
  { path: "/us", icon: Heart, label: "Us" },
];

// Single music entry — Groic is the unified music + listen-together hub.
// Saved playlists live inside Groic (route /playlist still works for deep links).
const SECONDARY: Tab[] = [
  { path: "/map", icon: MapPin, label: "Map" },
  { path: "/groic", icon: Music, label: "Music" },
  { path: "/settings", icon: Settings, label: "Settings" },
];

const HIDDEN_PAGES = ["/settings"];

const FloatingDock = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [isVisible, setIsVisible] = useState(true);
  const [moreOpen, setMoreOpen] = useState(false);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [missedCalls, setMissedCalls] = useState(0);
  const lastScrollY = useRef(0);
  const isHidden = HIDDEN_PAGES.includes(location.pathname);

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

  // ── Hide on scroll-down, show on scroll-up ─────────────────────────────────
  useEffect(() => {
    if (isHidden) return;
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const y = window.scrollY;
        const dy = y - lastScrollY.current;
        if (dy > 8 && y > 60) setIsVisible(false);
        else if (dy < -8 || y < 20) setIsVisible(true);
        lastScrollY.current = y;
        ticking = false;
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [isHidden]);

  useEffect(() => { setIsVisible(true); setMoreOpen(false); }, [location.pathname]);

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
          isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {isActive && (
          <motion.span
            layoutId="dock-active-pill"
            className="absolute inset-0 rounded-full bg-foreground/10"
            transition={{ type: "spring", stiffness: 500, damping: 38 }}
          />
        )}
        <Icon
          className="relative z-10 h-[20px] w-[20px]"
          strokeWidth={isActive ? 2.2 : 1.8}
        />
        {count > 0 && (
          <span className="absolute top-1 right-1 z-20 h-4 min-w-4 px-1 rounded-full bg-destructive text-destructive-foreground text-[9px] font-bold flex items-center justify-center leading-none">
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
    <>
      {/* Backdrop for the More sheet */}
      <AnimatePresence>
        {moreOpen && (
          <motion.button
            aria-label="Close menu"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => setMoreOpen(false)}
            className="fixed inset-0 z-40 bg-background/40 backdrop-blur-sm"
          />
        )}
      </AnimatePresence>

      <motion.nav
        initial={false}
        animate={{ y: isVisible ? 0 : 120, opacity: isVisible ? 1 : 0 }}
        transition={{ type: "spring", stiffness: 380, damping: 34 }}
        className="fixed left-0 right-0 z-50 flex justify-center pointer-events-none"
        style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 14px)" }}
        aria-label="Primary"
      >
        <div className="pointer-events-auto relative">
          {/* Expandable secondary sheet */}
          <AnimatePresence>
            {moreOpen && (
              <motion.div
                initial={{ opacity: 0, y: 8, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.96 }}
                transition={{ type: "spring", stiffness: 420, damping: 30 }}
                className={cn(
                  "absolute bottom-full mb-3 right-0",
                  "rounded-3xl p-2 flex items-center gap-1",
                  "bg-card/70 backdrop-blur-2xl border border-border/60",
                  "shadow-[0_20px_60px_-15px_hsl(var(--foreground)/0.25)]",
                )}
              >
                {SECONDARY.map((t) => renderTab(t))}
              </motion.div>
            )}
          </AnimatePresence>

          <div
            className={cn(
              "flex items-center gap-1 p-1.5 rounded-full",
              "bg-card/70 backdrop-blur-2xl border border-border/60",
              "shadow-[0_20px_60px_-20px_hsl(var(--foreground)/0.35)]",
            )}
          >
            {PRIMARY.map((t) => renderTab(t))}
            <button
              onClick={() => { triggerHaptic("light"); setMoreOpen((v) => !v); }}
              aria-label="More"
              aria-expanded={moreOpen}
              className={cn(
                "relative h-11 w-11 flex items-center justify-center rounded-full transition-colors active:scale-95",
                moreOpen ? "text-foreground bg-foreground/10" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <MoreHorizontal className="h-[20px] w-[20px]" strokeWidth={1.9} />
            </button>
          </div>
        </div>
      </motion.nav>
    </>
  );
};

export default FloatingDock;

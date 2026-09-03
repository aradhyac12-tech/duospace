import { useLocation, useNavigate } from "react-router-dom";
import { MessageCircle, Phone } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { swiftSpring } from "@/lib/motion";
import { useState, useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { routePreload } from "@/App";

const tabs = [
  { path: "/chat", icon: MessageCircle, label: "Chat", badgeKey: "messages" },
  { path: "/calls", icon: Phone, label: "Calls", badgeKey: "calls" },
];

const HIDDEN_PAGES = ["/settings"];

const BottomNav = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [isVisible, setIsVisible] = useState(true);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [missedCalls, setMissedCalls] = useState(0);
  const lastScrollY = useRef(0);
  const isHidden = HIDDEN_PAGES.includes(location.pathname);

  useEffect(() => {
    if (!user) return;

    const fetchCounts = async () => {
      const { count: msgCount } = await supabase
        .from("messages")
        .select("*", { count: "exact", head: true })
        .eq("receiver_id", user.id)
        .eq("is_read", false);
      setUnreadMessages(msgCount || 0);

      const { count: callCount } = await supabase
        .from("call_history")
        .select("*", { count: "exact", head: true })
        .eq("receiver_id", user.id)
        .eq("status", "missed");
      setMissedCalls(callCount || 0);
    };

    fetchCounts();

    const messagesChannel = supabase
      .channel("nav-unread-messages")
      .on("postgres_changes", { event: "*", schema: "public", table: "messages", filter: `receiver_id=eq.${user.id}` },
        () => fetchCounts())
      .subscribe();

    const callsChannel = supabase
      .channel("nav-missed-calls")
      .on("postgres_changes", { event: "*", schema: "public", table: "call_history", filter: `receiver_id=eq.${user.id}` },
        () => fetchCounts())
      .subscribe();

    return () => {
      supabase.removeChannel(messagesChannel);
      supabase.removeChannel(callsChannel);
    };
  }, [user]);

  // Fix #Bug7: also clear missed-call rows in DB when user views the calls page.
  // Previously only setMissedCalls(0) ran locally — on any reload fetchCounts()
  // re-queried the same "missed" rows and the badge reappeared.
  useEffect(() => {
    if (location.pathname === "/chat") setUnreadMessages(0);
    if (location.pathname === "/calls" && user) {
      setMissedCalls(0);
      // Mark all missed calls as seen in the database
      supabase
        .from("call_history")
        .update({ status: "seen" })
        .eq("receiver_id", user.id)
        .eq("status", "missed")
        .then(() => {}); // fire-and-forget; badge is already cleared locally
    }
  }, [location.pathname, user]);

  // Scroll-based auto-hide
  useEffect(() => {
    if (isHidden) return;
    let ticking = false;
    const handleScroll = () => {
      if (!ticking) {
        window.requestAnimationFrame(() => {
          const currentY = window.scrollY;
          const delta = currentY - lastScrollY.current;
          if (delta > 8 && currentY > 60) setIsVisible(false);
          else if (delta < -8) setIsVisible(true);
          if (currentY < 20) setIsVisible(true);
          lastScrollY.current = currentY;
          ticking = false;
        });
        ticking = true;
      }
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, [isHidden]);

  useEffect(() => {
    setIsVisible(true);
    lastScrollY.current = 0;
  }, [location.pathname]);

  if (isHidden) return null;

  const getBadgeCount = (key?: string) => {
    if (key === "messages") return unreadMessages;
    if (key === "calls") return missedCalls;
    return 0;
  };

  return (
    <motion.nav
      initial={{ y: 0 }}
      animate={{ y: isVisible ? 0 : 140 }}
      transition={{ type: "spring", stiffness: 400, damping: 35 }}
      className="fixed bottom-3 left-1/2 -translate-x-1/2 z-50 w-fit rounded-full border border-white/15 dark:border-white/10 bg-white/55 dark:bg-black/40 backdrop-blur-2xl backdrop-saturate-150 shadow-[0_8px_30px_-8px_rgba(0,0,0,0.25)] safe-bottom"
    >
      <div className="flex items-center justify-center gap-1 h-14 px-2">
        {tabs.map((tab) => {
          const isActive = location.pathname === tab.path;
          const Icon = tab.icon;
          const badgeCount = getBadgeCount(tab.badgeKey);
          return (
            <button
              key={tab.path}
              onClick={() => navigate(tab.path)}
              onPointerDown={() => routePreload[tab.path]?.().catch(() => {})}
              className={cn(
                "relative flex flex-col items-center justify-center gap-0.5 w-14 h-14 rounded-2xl transition-colors",
                isActive ? "text-foreground" : "text-muted-foreground"
              )}
            >
              {isActive && (
                <motion.div
                  layoutId="activeTab"
                  className="absolute inset-0 bg-accent rounded-2xl"
                  transition={swiftSpring}
                />
              )}
              <div className="relative">
                <Icon className="relative z-10 h-5 w-5" strokeWidth={isActive ? 2.2 : 1.8} />
                {/* F5: Notification badge */}
                {badgeCount > 0 && (
                  <span className="absolute -top-2 -right-2.5 h-4 min-w-4 px-1 bg-destructive text-destructive-foreground text-[9px] font-bold rounded-full flex items-center justify-center z-20 leading-none">
                    {badgeCount > 99 ? "99+" : badgeCount}
                  </span>
                )}
              </div>
              <span className="relative z-10 text-[10px] font-medium tracking-wide">{tab.label}</span>
            </button>
          );
        })}
      </div>
    </motion.nav>
  );
};

export default BottomNav;

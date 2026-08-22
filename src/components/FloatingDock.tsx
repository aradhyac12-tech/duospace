import { useLocation, useNavigate } from "react-router-dom";
import { MessageCircle, Phone } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { routePreload } from "@/App";
import { hapticTick } from "@/lib/haptics";
import { gentleSpring, quickSpring, standardTransition } from "@/lib/motion";
import { useDockCompactState } from "@/hooks/useDockCompact";
// Dock nav is a "tab focus" interaction — hapticTick is the haptics system's
// own documented choice for that (see src/lib/haptics.ts), not a generic tap.
const triggerHaptic = (_kind?: string) => { hapticTick(); };

type Tab = {
  path: string;
  icon: typeof MessageCircle;
  label: string;
  badgeKey?: "messages" | "calls";
};

// Phase 3 (reverting a Phase 1 experiment): back to exactly 2 primary tabs —
// Chat and Calls. Phase 1 had promoted a third "Duo" tab (a standalone
// /duo page mirroring the shared-space hub) but that page and its dock
// presence caused a confusing extra "current page menu" affordance and
// was explicitly reverted per direct product feedback. Every shared
// feature (Gallery, Map, Groic/Music, Us, Shayari, Love Letter, Schedule
// Send) is reachable exclusively through the in-chat sparkle "Hub"
// (GridMenu, opened from Chat.tsx) again, same as before Phase 1. Settings
// still lives behind Profile (tap the partner name/avatar in the Chat
// header) — it remains a secondary destination, not a primary tab.
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
  // Phase 1: purely cosmetic — a small scale/opacity step while the current
  // page is actively scrolling (see useDockCompact.ts). This is NOT the
  // isVisible/isHidden hide mechanism above and never unmounts, never drops
  // opacity to 0, and never blocks pointer events — the dock stays fully
  // tappable at every point in this animation, it's just a little smaller.
  const isCompact = useDockCompactState();

  // ── Realtime badge counts ──────────────────────────────────────────────────
  // PERF FIX (Phase 8): each channel used to call the same fetchCounts(),
  // which re-ran BOTH count queries (messages AND call_history) no matter
  // which table actually changed — every incoming message re-queried missed
  // calls, and every call event re-queried unread messages. Split into two
  // targeted refetchers so each channel only re-runs the query for its own
  // table.
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

  const badgeFor = (key?: Tab["badgeKey"]) =>
    key === "messages" ? unreadMessages : key === "calls" ? missedCalls : 0;

  const go = (path: string) => {
    triggerHaptic("light");
    navigate(path);
  };

  const renderTab = (tab: Tab, opts?: { compact?: boolean; focusable?: boolean }) => {
    const isActive = location.pathname === tab.path;
    const Icon = tab.icon;
    const count = badgeFor(tab.badgeKey);
    return (
      <motion.button
        key={tab.path}
        onClick={() => go(tab.path)}
        onPointerDown={() => routePreload[tab.path]?.().catch(() => {})}
        aria-label={tab.label}
        aria-current={isActive ? "page" : undefined}
        // Accessibility (section 26): aria-hidden on the outer <nav> below
        // hides the dock from assistive tech while isHidden/!isVisible,
        // but aria-hidden alone doesn't remove focusability — a sighted
        // keyboard user tabbing through could still land on these buttons
        // while they're invisible (translated off-screen/opacity 0). This
        // dock is kept mounted rather than unmounted while hidden (see the
        // comment on the outer <nav>), so that's a real reachable gap, not
        // theoretical. tabIndex={-1} while not focusable is the fix;
        // omitted (default tab order) otherwise.
        tabIndex={opts?.focusable === false ? -1 : undefined}
        // Phase 2.5: whileTap replaces the plain CSS active:scale-95 — a
        // spring-driven compression (not a linear CSS transition) is what
        // reads as "material compressing" rather than "button shrinking".
        // Scale is intentionally tiny (0.94) per spec ("tiny scale
        // reduction... no large ripple, no colored flash").
        whileTap={{ scale: 0.94 }}
        transition={quickSpring}
        className={cn(
          "relative flex items-center justify-center rounded-full outline-none",
          "h-11 w-11",
          isActive ? "text-primary" : "text-muted-foreground hover:text-foreground transition-colors",
        )}
      >
        {isActive && (
          // Phase 2 (visual correction): the active indicator is now a small
          // glass "lens" nested in the dock's own material (.glass-dock-lens,
          // see index.css) rather than a flat tinted pill — reads as a denser
          // pocket of the SAME glass, not a different coloured chip. layoutId
          // still drives the morph between Chat/Calls; only the surface it
          // morphs changed.
          <motion.span
            layoutId="dock-active-pill"
            className="absolute inset-0 glass-dock-lens"
            transition={gentleSpring}
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
      </motion.button>
    );
  };

  return (
    <motion.nav
      initial={false}
      // FIX (shell redesign): isVisible is no longer scroll-driven — see
      // useDockVisibility.ts. It now only goes false for a genuine
      // full-screen interaction (active call, photo/video viewer, camera)
      // that would otherwise sit underneath the dock. Page-based hiding
      // (Settings/Profile) and immersive-hiding drive the exact same
      // spring, so there's one consistent hide/show motion regardless of
      // which of the two ever causes it — never an abrupt unmount-to-
      // nothing for one case and an animated slide for the other. Kept
      // mounted (not conditionally rendered) so the badge-count realtime
      // subscriptions below keep running in the background while hidden,
      // instead of tearing down and refetching every time it reappears.
      animate={{
        y: (isVisible && !isHidden) ? 0 : 120,
        opacity: (isVisible && !isHidden) ? 1 : 0,
      }}
      // BUG FIX ("dock behaves like a bouncing bag"): this whole-dock
      // hide/show slide used to share `gentleSpring` with the small
      // active-tab-pill morph below. That's fine for the pill (a tiny,
      // contained, infrequent layout morph — exactly the "genuinely
      // communicates physical movement" case gentleSpring's own doc
      // comment describes) but wrong for this: a 120px slide that can
      // retrigger repeatedly in quick succession during ordinary scroll
      // (see useDockCompactReporter's direction handling) is a frequent,
      // ambient animation, not an occasional deliberate one, and a spring
      // that gets re-targeted mid-motion before it's settled is exactly
      // what reads as jiggling/bouncy rather than a single clean slide. A
      // plain eased tween (the same DUR_MED/EASE_SMOOTH used everywhere
      // else in the app) is monotonic by construction — it can never
      // overshoot or oscillate no matter how often it's retriggered —
      // while still feeling deliberate rather than abrupt. Kept as a
      // spring only where the motion is small, self-contained, and
      // infrequent (the active-tab pill morph, still gentleSpring below).
      transition={standardTransition}
      className="fixed left-0 right-0 z-50 flex justify-center pointer-events-none"
      style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + var(--dock-gap))" }}
      aria-label="Primary"
      aria-hidden={isHidden || !isVisible}
    >
      <motion.div
        animate={{ scale: isCompact ? 0.92 : 1, opacity: isCompact ? 0.88 : 1 }}
        // Same fix as above and for the same reason — isCompact toggles on
        // ordinary scroll, i.e. frequently and often in quick reversal, so
        // this uses the same non-oscillating tween rather than a spring.
        transition={standardTransition}
        className={cn(
          "pointer-events-auto flex items-center gap-2 px-2 py-1.5 rounded-full",
          "glass-dock",
        )}
      >
        {PRIMARY.map((t) => renderTab(t, { focusable: isVisible && !isHidden }))}
      </motion.div>
    </motion.nav>
  );
};

export default FloatingDock;

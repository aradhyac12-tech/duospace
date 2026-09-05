import { useLocation, useNavigate } from "react-router-dom";
import { MessageCircle, Phone } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { routePreload } from "@/App";
import { gentleSpring, quickSpring } from "@/lib/motion";
import { useDockBadges } from "@/hooks/useDockBadges";

// Deliberately silent: bottom-nav taps happen constantly during normal
// use, so this no longer fires haptics on every tab switch (kept as a
// named no-op so call sites don't need to change).
const triggerHaptic = () => {};

type Tab = {
  path: string;
  icon: typeof MessageCircle;
  label: string;
  badgeKey: "messages" | "calls";
};

const PRIMARY: Tab[] = [
  { path: "/chat", icon: MessageCircle, label: "Chat", badgeKey: "messages" },
  { path: "/calls", icon: Phone, label: "Calls", badgeKey: "calls" },
];

interface DockNavRowProps {
  /** Whether the row's buttons should be reachable by keyboard/AT right now
   *  — false while the whole shell is hidden/collapsed (dock scroll-hide on
   *  other pages, or a fully-collapsed unified surface state). */
  focusable?: boolean;
  /** "lens" (default) draws the active-tab glass lens (used standalone in
   *  FloatingDock, which has no other affordance nearby). "plain" omits it
   *  when the unified surface already supplies its own active indicator
   *  treatment — kept as an option rather than always drawing two nested
   *  lenses. Currently both callers use "lens"; the option exists so a
   *  future surface-specific indicator doesn't have to fork this file. */
  indicatorVariant?: "lens" | "plain";
}

/**
 * Pure tab-button row — no outer positioning, no glass material of its own.
 * Extracted from FloatingDock.tsx (Phase 5.5: Unified Bottom Surface) so the
 * exact same buttons, badges, active-lens morph, and haptics are shared
 * between FloatingDock (the standalone dock used on every page except
 * Chat/Calls) and DuoSpaceBottomSurface's nav row (Chat/Calls). Only one
 * `layoutId="dock-active-pill"` exists in the tree at a time in practice
 * (FloatingDock and DuoSpaceBottomSurface are never both mounted — AppLayout
 * renders exactly one of them per route), so the shared layoutId still
 * morphs correctly rather than fighting a second instance.
 */
const DockNavRow = ({ focusable = true, indicatorVariant = "lens" }: DockNavRowProps) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { unreadMessages, missedCalls } = useDockBadges();

  const badgeFor = (key: Tab["badgeKey"]) => (key === "messages" ? unreadMessages : missedCalls);

  const go = (path: string) => {
    triggerHaptic();
    navigate(path);
  };

  return (
    <>
      {PRIMARY.map((tab) => {
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
            tabIndex={focusable ? undefined : -1}
            whileTap={{ scale: 0.94 }}
            transition={quickSpring}
            className={cn(
              "relative flex flex-1 items-center justify-center gap-1.5 rounded-full outline-none",
              "h-11 min-w-0 px-2.5",
              isActive ? "text-primary" : "text-muted-foreground hover:text-foreground transition-colors",
            )}
          >
            {isActive && indicatorVariant === "lens" && (
              <motion.span
                layoutId="dock-active-pill"
                className="absolute inset-0 glass-dock-lens"
                transition={gentleSpring}
              />
            )}
            <span className="relative z-10 shrink-0">
              <Icon
                className="h-[18px] w-[18px]"
                strokeWidth={isActive ? 2.2 : 1.8}
                fill={isActive ? "currentColor" : "none"}
                fillOpacity={isActive ? 0.12 : 0}
              />
              {count > 0 && (
                <span className="absolute -top-1.5 -right-2 z-20 h-4 min-w-4 px-1 rounded-full bg-destructive text-destructive-foreground text-[9px] font-bold flex items-center justify-center leading-none ring-2 ring-background">
                  {count > 99 ? "99+" : count}
                </span>
              )}
            </span>
            <span
              className={cn(
                "relative z-10 text-[11px] font-medium tracking-wide truncate transition-opacity",
                isActive ? "opacity-100" : "opacity-70",
              )}
            >
              {tab.label}
            </span>
          </motion.button>
        );
      })}
    </>
  );
};

export default DockNavRow;

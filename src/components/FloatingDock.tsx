import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { standardTransition } from "@/lib/motion";
import { useDockCompactState } from "@/hooks/useDockCompact";
import DockNavRow from "@/components/dock/DockNavRow";

// Phase 3 (reverting a Phase 1 experiment): back to exactly 2 primary tabs —
// Chat and Calls. Every shared feature (Gallery, Map, Groic/Music, Us,
// Shayari, Love Letter, Schedule Send) is reachable exclusively through the
// in-chat sparkle "Hub" again. Settings still lives behind Profile.
//
// Phase 5.5 (Unified Bottom Surface): on /chat and /calls this standalone
// dock is no longer rendered at all — AppLayout swaps it for
// DuoSpaceBottomSurface, which fuses the nav row into the SAME glass shell
// as the composer (see that file). This component now only renders on every
// OTHER page (Gallery/Map/Groic/Us/Shayari/etc.), where there's no composer
// to unify with and the prior standalone-pill treatment still applies
// unchanged. The actual tab-button rendering (icons, badges, active lens,
// haptics) was extracted to DockNavRow.tsx so both surfaces share one
// implementation rather than two that could drift.

interface FloatingDockProps {
  /** Lifted up to AppLayout so its reserved bottom padding can animate in
   *  sync with the dock instead of leaving a static gap when it hides —
   *  see hooks/useDockVisibility.ts. */
  isVisible: boolean;
  isHidden: boolean;
}

const FloatingDock = ({ isVisible, isHidden }: FloatingDockProps) => {
  // Phase 1: purely cosmetic — a small scale/opacity step while the current
  // page is actively scrolling (see useDockCompact.ts). This is NOT the
  // isVisible/isHidden hide mechanism above and never unmounts, never drops
  // opacity to 0, and never blocks pointer events — the dock stays fully
  // tappable at every point in this animation, it's just a little smaller.
  const isCompact = useDockCompactState();

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
      // subscriptions (inside DockNavRow/useDockBadges) keep running in the
      // background while hidden, instead of tearing down and refetching
      // every time it reappears.
      animate={{
        y: (isVisible && !isHidden) ? 0 : 120,
        opacity: (isVisible && !isHidden) ? 1 : 0,
      }}
      // BUG FIX ("dock behaves like a bouncing bag"): this whole-dock
      // hide/show slide used to share `gentleSpring` with the small
      // active-tab-pill morph. That's fine for the pill (a tiny, contained,
      // infrequent layout morph) but wrong for this: a 120px slide that can
      // retrigger repeatedly in quick succession during ordinary scroll is
      // a frequent, ambient animation, not an occasional deliberate one,
      // and a spring that gets re-targeted mid-motion before it's settled
      // is exactly what reads as jiggling/bouncy rather than a single
      // clean slide. A plain eased tween is monotonic by construction.
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
          "pointer-events-auto flex items-center gap-1.5 w-[172px] h-[60px] px-2 rounded-full",
          "glass-dock",
        )}
      >
        <DockNavRow focusable={isVisible && !isHidden} />
      </motion.div>
    </motion.nav>
  );
};

export default FloatingDock;

import { useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { standardTransition } from "@/lib/motion";
import { useKeyboardOpen } from "@/hooks/useKeyboardOpen";
import DockNavRow from "@/components/dock/DockNavRow";
import { useRegisterComposerHost, useReportSurfaceHeight } from "@/contexts/BottomSurfaceContext";

/**
 * DuoSpaceBottomSurface — Phase 5.5: Unified Bottom Surface + Zero-Flicker
 * Navigation, brief section 1.
 *
 * ONE continuous glass shell replacing the old separate composer pill +
 * floating dock pill on /chat and /calls. Structure:
 *
 *   ┌ shell (this component, fixed, centered, one glass material) ─────┐
 *   │  composer slot (Chat portals MessageComposer's whole JSX in here, │
 *   │  height/opacity-animated: expanded on Chat, collapsed on Calls)  │
 *   │  nav row (DockNavRow — always present, physically stable)        │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * Mounted once by AppLayout for the lifetime of /chat + /calls (both tabs,
 * not remounted on switch — brief section 4: "keep the bottom surface
 * itself mounted"). Owns positioning/safe-area/keyboard-follow for both the
 * composer and the nav row, which is why MessageComposer.tsx no longer has
 * any of that math itself.
 */

interface DuoSpaceBottomSurfaceProps {
  /** True on /chat — expands the composer slot. False on /calls — collapses
   *  it smoothly while the nav row stays put (brief section 4). */
  composerExpanded: boolean;
}

const DuoSpaceBottomSurface = ({ composerExpanded }: DuoSpaceBottomSurfaceProps) => {
  const shellRef = useRef<HTMLDivElement>(null);
  const composerHostRef = useRef<HTMLDivElement>(null);
  const setComposerHost = useRegisterComposerHost();
  const reportHeight = useReportSurfaceHeight();
  const keyboardOpen = useKeyboardOpen();

  // Register the portal target ONCE on mount (not via an inline ref
  // callback — a new function identity every render would make React
  // call it with null-then-node on every re-render, which would flip
  // Chat's portal target to null-then-back and momentarily unmount the
  // composer's DOM — exactly the kind of flicker this whole phase exists
  // to remove). This shell is mounted once for the lifetime of /chat +
  // /calls, so "once on mount" is also "for as long as it matters".
  useEffect(() => {
    setComposerHost(composerHostRef.current);
    return () => setComposerHost(null);
  }, [setComposerHost]);

  // Live height reporting (brief section 2: "use measured/dynamic
  // dimensions... rather than magic numbers") — Chat's message list and
  // Calls' content list read this back as their bottom scroll-inset, so it
  // always matches whatever this shell's ACTUAL current height is
  // (composer expanded/collapsed, attach tray open, recording state,
  // multiline growth) without either side hand-coordinating pixel values.
  useEffect(() => {
    const el = shellRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height ?? el.offsetHeight;
      // +gap between the shell and the safe-area edge, so content clears
      // the shell's true visual footprint, not just its own box height.
      reportHeight(h + 16);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [reportHeight]);

  return (
    <motion.div
      initial={false}
      className="fixed left-0 right-0 z-40 flex justify-center pointer-events-none"
      // Section 10 (keyboard): fixed positioning + Keyboard.resize="body"
      // already means the viewport itself shrinks when the keyboard opens,
      // so bottom:0-anchored content naturally sits right above it with no
      // JS height-tracking needed. The only correction needed is dropping
      // the safe-area inset while the keyboard's up (it can otherwise keep
      // reporting home-indicator height even though the keyboard already
      // covers that area — same root cause useKeyboardOpen's own doc
      // comment describes for the old per-composer padding).
      animate={{
        bottom: `calc(${keyboardOpen ? "0px" : "env(safe-area-inset-bottom, 0px)"} + 14px)`,
      }}
      transition={standardTransition}
    >
      <motion.div
        ref={shellRef}
        layout
        transition={standardTransition}
        className={cn(
          "pointer-events-auto glass-dock rounded-floating overflow-hidden",
          "w-[calc(100%-24px)] max-w-[520px]",
        )}
      >
        {/* Composer slot — Chat.tsx portals MessageComposer's full JSX
            (reply/edit banners, attach tray, recording UI, input row) into
            the div below via useComposerHost(). Height/opacity-animated as
            ONE piece so switching to Calls reads as this surface's own
            material folding away, not a child abruptly vanishing (brief
            section 4). */}
        <motion.div
          initial={false}
          animate={{ height: composerExpanded ? "auto" : 0, opacity: composerExpanded ? 1 : 0 }}
          transition={standardTransition}
          style={{ overflow: "hidden" }}
        >
          <div ref={composerHostRef} />
        </motion.div>

        {/* Nav row — physically stable across Chat ↔ Calls (brief section
            4: "the navigation row remains physically stable"). Same
            DockNavRow FloatingDock uses on every other page, so badges/
            active-lens/haptics are identical, just inside this shell
            instead of a standalone pill. */}
        <div className="flex items-center gap-1.5 h-[60px] px-2">
          <DockNavRow focusable indicatorVariant="lens" />
        </div>
      </motion.div>
    </motion.div>
  );
};

export default DuoSpaceBottomSurface;

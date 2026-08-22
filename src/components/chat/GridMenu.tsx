import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { Feather, Clock, Sparkles, X } from "lucide-react";
import { hapticLight, hapticSelection } from "@/lib/haptics";
import { useLongPress } from "@/hooks/useLongPress";
import { gentlePanelSpring, standardTransition, microTransition } from "@/lib/motion";
import { DUO_HUB_ITEMS } from "@/lib/duoHubItems";

interface GridMenuProps {
  onClose: () => void;
  // F3, F4: callbacks for chat-specific actions
  onScheduledMessage?: () => void;
  onLoveLetter?: () => void;
}

interface HubButtonProps {
  onClick: () => void;
  isOpen: boolean;
  onLongPress?: () => void;
}

/**
 * FIX (shell redesign — HubButton): was a 90° clockwise spin of the same
 * Sparkles glyph, plus a fairly aggressive whileTap 0.88. Per the redesign
 * brief, a spin only reads correctly if it visually resolves into
 * something — this one didn't communicate "now tap to close." Replaced
 * with a crossfade to an explicit X (clearer affordance: closed = "open
 * shared features", open = "close this"), and softened the tap to a
 * genuine compress-and-settle rather than a visible shrink.
 */
export const HubButton = ({ onClick, isOpen, onLongPress }: HubButtonProps) => {
  // 900ms: long enough that a normal tap (which opens the hub menu) never
  // misfires this, short enough not to feel unresponsive as a "hold"
  // gesture — most native long-press affordances land in the 500-900ms
  // range; a literal multi-second hold would feel broken for this kind of
  // shortcut even though it's fine for Instagram's continuous swipe gesture.
  const lp = useLongPress(() => { if (onLongPress) onLongPress(); }, 900);
  return (
    <motion.button
      onClick={onClick}
      {...(onLongPress ? lp : {})}
      whileTap={{ scale: 0.96 }}
      animate={{
        scale: isOpen ? 1.04 : 1,
        backgroundColor: isOpen ? "hsl(var(--primary))" : "hsl(var(--muted))",
      }}
      transition={{ ...gentlePanelSpring, backgroundColor: standardTransition }}
      aria-label="Open gallery, music and more"
      aria-expanded={isOpen}
      aria-controls="chat-hub-menu"
      id="chat-hub-button"
      className="h-11 w-11 rounded-full flex items-center justify-center shrink-0 relative overflow-hidden"
    >
      <AnimatePresence mode="wait" initial={false}>
        {isOpen ? (
          <motion.span
            key="close"
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.7 }}
            transition={microTransition}
            className="absolute inset-0 flex items-center justify-center"
          >
            <X className="h-4 w-4 text-primary-foreground" />
          </motion.span>
        ) : (
          <motion.span
            key="sparkle"
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.7 }}
            transition={microTransition}
            className="absolute inset-0 flex items-center justify-center"
          >
            <Sparkles className="h-4 w-4 text-foreground" />
          </motion.span>
        )}
      </AnimatePresence>
    </motion.button>
  );
};


// This list lives once in src/lib/duoHubItems.ts (see that file for why).
// Music points at /groic — the unified music + listen-together hub (saved
// playlists still open via /playlist as a deep link, but /groic is the
// entry point everywhere else now). Frequent = things a couple opens
// often (Gallery, Music); everything else is more occasional/ceremonial.
// Rendered as one vertical list (see FIX below) — the hierarchy between
// tiers comes from row styling (accent tint on Frequent rows) only, never
// from separate layouts.
const frequentItems = DUO_HUB_ITEMS.filter(i => i.tier === "frequent");
const moreItems = DUO_HUB_ITEMS.filter(i => i.tier === "more");

// FIX (hub should open as a vertical list directly above the hub button,
// "unfurling" out of it, not pop in all at once as a 2-column block): the
// panel's own fade+scale (below) is the container appearing; this
// orchestrates the ROWS within it. staggerDirection: -1 on open walks
// DOM-last-to-first, i.e. the row closest to the hub button (bottom of the
// list) animates in first and each row above follows in sequence — reads
// as the list growing upward out of the button. Close reverses that:
// staggerDirection: 1 retracts top-to-bottom, so the list collapses back
// down into the button it came from, symmetric with how it opened.
const listVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.032, staggerDirection: -1 } },
  exit: { transition: { staggerChildren: 0.022, staggerDirection: 1 } },
};
const rowVariants = {
  hidden: { opacity: 0, y: 10, scale: 0.94 },
  visible: { opacity: 1, y: 0, scale: 1, transition: gentlePanelSpring },
  exit: { opacity: 0, y: 6, scale: 0.96, transition: microTransition },
};

const GridMenu = ({ onClose, onScheduledMessage, onLoveLetter }: GridMenuProps) => {
  const navigate = useNavigate();
  // Portal root (`fixed inset-0`, see the JSX below) — measured directly
  // instead of relying on window.innerHeight, see the BUG FIX below.
  const containerRef = useRef<HTMLDivElement>(null);

  // BUG FIX (hub list not appearing directly above the hub button — a
  // visible gap between the two, on Samsung Internet specifically):
  // ***
  // REPEAT BUG FIX — the previous fix here (see the surviving comment
  // below) measured the button's position correctly but combined it with
  // `window.innerHeight` to get a `bottom` offset:
  //     anchorBottom = window.innerHeight - rect.top + GAP
  // `getBoundingClientRect()` always reflects the browser's *actual
  // current* visible viewport. `window.innerHeight`, on the other hand,
  // does not reliably track that on mobile browsers with a dynamic/
  // expandable address bar — Samsung Internet in particular can report an
  // `innerHeight` that doesn't match the real visible area at the moment
  // of measurement, especially right as the address bar is
  // showing/settling. Mixing a live DOM measurement (rect.top) with that
  // unreliable figure (innerHeight) is what pushed the panel's computed
  // `bottom` far too large, floating the whole thing up near the top of
  // the screen instead of directly above the button.
  //
  // The previous fix DID add a `window.visualViewport` resize listener
  // (below) to *trigger* a recompute on exactly this kind of viewport
  // change — a reasonable instinct — but the computation it re-ran still
  // used `window.innerHeight`, so every recompute kept reproducing the
  // same wrong number. That's why this kept coming back despite repeated
  // attempts: the trigger was right, the formula it triggered wasn't.
  //
  // Fixed by removing any "viewport height" API from the formula
  // entirely. Both the button and this panel are DOM descendants of the
  // exact same `fixed inset-0` portal container (ref'd below) — that
  // container's own rendered `getBoundingClientRect()` IS the real
  // visible viewport, measured the identical way the button's rect is, so
  // there's no second source of truth to go out of sync with. `bottom`
  // and `top` here are two live measurements in one coordinate space, not
  // one live measurement reconciled against a separately-reported number.
  // ***
  // (Original fix, still accurate as background:) the panel's `bottom`
  // offset used to be a fixed CSS calc assuming the floating nav dock is
  // always visible (env(safe-area-inset-bottom) + --dock-reserve + 12px).
  // But the dock hides — and AppLayout's reserved bottom padding collapses
  // with it — the moment the message field is focused (see
  // MessageComposer.tsx's useSetImmersive("chat-composer-typing", ...)),
  // which is exactly when someone taps the Hub button right after typing.
  // In that state the real button sits ~84px lower than a fixed constant
  // would assume, so the panel opened floating well above it instead of
  // sitting right on top of it. Fixed at the source instead of re-guessing
  // a second constant: measure the actual #chat-hub-button position at
  // open time (and keep it updated across resizes/keyboard show-hide)
  // rather than assuming any fixed reserved space. This is correct
  // regardless of whether the dock is showing, hidden, compact, or
  // anything else changes its layout in the future.
  const GAP_ABOVE_BUTTON = 12;
  const measureAnchorBottom = () => {
    if (typeof window === "undefined") return 96;
    const btn = document.getElementById("chat-hub-button");
    if (!btn) return 96; // defensive fallback, shouldn't happen — button is always mounted before Hub can be opened
    const rect = btn.getBoundingClientRect();
    // containerRef isn't mounted yet on the very first render (this same
    // function also serves as the useState initializer, which runs before
    // React has committed anything to the DOM) — window.innerHeight is
    // used ONLY as that one-frame fallback guess. useLayoutEffect below
    // re-measures against the now-mounted container synchronously before
    // the browser paints, so the user never actually sees a frame
    // positioned from this fallback value.
    const containerBottom = containerRef.current?.getBoundingClientRect().bottom ?? window.innerHeight;
    return Math.max(0, containerBottom - rect.top + GAP_ABOVE_BUTTON);
  };
  const [anchorBottom, setAnchorBottom] = useState(measureAnchorBottom);

  useLayoutEffect(() => {
    const recompute = () => setAnchorBottom(measureAnchorBottom());
    recompute();
    window.addEventListener("resize", recompute);
    window.visualViewport?.addEventListener("resize", recompute);
    return () => {
      window.removeEventListener("resize", recompute);
      window.visualViewport?.removeEventListener("resize", recompute);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Escape closes the hub — the backdrop's click-to-dismiss (below) isn't
  // reachable from a keyboard/screen reader, so without this the menu had
  // no keyboard-accessible way to close at all once opened.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") { hapticLight(); onClose(); } };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Defer navigation until after the close/exit animation so the sheet
  // gracefully dismisses before the route changes.
  const runThenClose = (fn: () => void) => {
    hapticLight();
    onClose();
    window.setTimeout(fn, 140);
  };

  const actionItems = [
    onLoveLetter && { icon: Feather, label: "Love Letter", action: () => runThenClose(onLoveLetter) },
    onScheduledMessage && { icon: Clock, label: "Schedule Send", action: () => runThenClose(onScheduledMessage) },
  ].filter(Boolean) as { icon: React.ElementType; label: string; action: () => void }[];

  const frequent = frequentItems.map(i => ({
    icon: i.icon, label: i.label, action: () => { hapticSelection(); runThenClose(() => navigate(i.path)); },
  }));
  const more = [...moreItems.map(i => ({
    icon: i.icon, label: i.label, action: () => runThenClose(() => navigate(i.path)),
  })), ...actionItems];

  // One consistent row geometry for every item in both tiers — same
  // height, same icon-well size, same radius. Tier hierarchy comes from
  // background/icon-color treatment only, never from differently-sized
  // rows. `motion.li` (rather than a plain button) so each row can
  // participate in the parent list's stagger orchestration above.
  const Row = ({ item, prominent }: { item: typeof frequent[number]; prominent: boolean }) => {
    const Icon = item.icon;
    return (
      <motion.li variants={rowVariants} role="none" className="list-none">
        <button
          role="menuitem"
          onClick={item.action}
          className={`flex items-center gap-3 w-full h-12 px-3 rounded-2xl transition-[background-color,transform] active:scale-[0.98] ${
            prominent
              ? "bg-primary/10 hover:bg-primary/14 border border-primary/20"
              : "bg-foreground/[0.03] hover:bg-foreground/[0.06] border border-border/40"
          }`}
        >
          <span className={`h-8 w-8 rounded-full flex items-center justify-center shrink-0 ${prominent ? "bg-primary/15" : "bg-muted/70"}`}>
            <Icon className={prominent ? "h-[16px] w-[16px] text-primary" : "h-[15px] w-[15px] text-foreground/75"} aria-hidden="true" />
          </span>
          <span className={`text-[13px] font-medium ${prominent ? "text-foreground" : "text-foreground/80"}`}>
            {item.label}
          </span>
        </button>
      </motion.li>
    );
  };

  return createPortal(
    <motion.div
      // FIX ("aggressive full-screen dark overlay... feels like a modal
      // interruption"): was bg-background/40 + backdrop-blur-[2px]. This
      // is a click-catcher and a very light environmental dim, not a
      // scrim — the user should still feel like they're looking at Chat,
      // just with a panel in front of it.
      //
      // FIX (hub opening near the top-left corner instead of anchored
      // bottom-right by the Hub button): this was rendered inline inside
      // Chat.tsx, which sits inside AppLayout's page-transition
      // `motion.div` (the one wrapping <Outlet/> — see AppLayout.tsx).
      // Framer Motion applies its animated properties (x/y/scale/filter)
      // as inline CSS `transform`/`filter` styles, and by spec ANY
      // ancestor with a `transform` or `filter` becomes the containing
      // block for `position: fixed` descendants — instead of the actual
      // viewport. So this panel's "fixed inset-0" + "right-3" positioning
      // was being computed relative to that animated wrapper's box, not
      // the screen, which is what put it in the wrong corner. Rendering
      // through a portal straight onto document.body sidesteps that
      // entirely — this is now guaranteed viewport-relative regardless of
      // what any ancestor's CSS does.
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={microTransition}
      className="fixed inset-0 z-50 bg-background/10"
      ref={containerRef}
      onClick={() => { hapticLight(); onClose(); }}
    >
      {/* Panel geometry + positioning: one glass panel of fixed, predictable
          geometry, anchored bottom-right near the hub button. `bottom` is
          now the measured `anchorBottom` (see the BUG FIX comment above)
          rather than a hardcoded --dock-reserve assumption, so this stays
          correct whether the dock is showing, hidden, or compact. */}
      <motion.div
        id="chat-hub-menu"
        role="menu"
        aria-label="Shared features"
        initial={{ opacity: 0, scale: 0.85, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.9, y: 6 }}
        transition={gentlePanelSpring}
        style={{
          // FIX (hub should open directly above the hub button, as a
          // vertical list, not a wide block off to the side): narrowed
          // from a 296px 2-column grid to a 208px single column that sits
          // right on top of the button (right-3 matches the composer's own
          // right inset, so this column's right edge lines up with the
          // hub button's right edge exactly, same as the button itself
          // sitting flush against the composer's edge).
          transformOrigin: "bottom right",
          bottom: anchorBottom,
          // FIX (panel clipped under the browser/status bar): this panel is
          // anchored by `bottom` and grows upward with its content. If its
          // natural height exceeds the space between the anchor and the
          // top of the viewport, the top rows get pushed up past y=0,
          // under the browser chrome, with no way to reach them since the
          // backdrop isn't scrollable. Capping height to the actual
          // available space and scrolling internally keeps every row
          // reachable regardless of viewport height or item count.
          maxHeight: `calc(100vh - ${anchorBottom}px - env(safe-area-inset-top, 0px) - 12px)`,
          overflowY: "auto",
        }}
        className="absolute right-3 w-[208px] rounded-[26px] p-2 glass-hub"
        onClick={(e) => e.stopPropagation()}
      >
        {/* FIX (opening/closing should read as a vertical list unfurling
            out of the hub button, not the whole block popping in at once):
            variants+staggerChildren on this list orchestrate each row's
            own enter/exit (see listVariants/rowVariants above) instead of
            every row appearing in the same single fade as the panel. The
            panel itself (outer motion.div) still does the overall
            scale/opacity pop from bottom-right; this adds the sequential
            per-row motion inside it. */}
        <motion.ul
          role="none"
          variants={listVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
          className="flex flex-col gap-1"
        >
          {[...frequent.map((item) => ({ item, prominent: true })), ...more.map((item) => ({ item, prominent: false }))]
            .map(({ item, prominent }) => <Row key={item.label} item={item} prominent={prominent} />)}
        </motion.ul>
      </motion.div>
    </motion.div>,
    document.body,
  );
};


export default GridMenu;

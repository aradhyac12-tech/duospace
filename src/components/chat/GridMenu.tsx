import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { Feather, Clock, Sparkles, X, type LucideIcon } from "lucide-react";
import { useLongPress } from "@/hooks/useLongPress";
import { gentlePanelSpring, standardTransition, microTransition, quickSpring } from "@/lib/motion";
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
// PERF FIX (hub felt laggy opening/closing): the stagger interval and the
// gentlePanelSpring used per-row (stiffness 320/damping 32/mass 1, ~250ms
// to settle) were designed for a leisurely "unfurl," but stacked across up
// to 7 rows that pushed total open time toward ~500-700ms and close toward
// ~400-600ms — reads as lag, not polish. Swapped each row's own transition
// to quickSpring (620/38/mass 0.6, ~120-150ms to settle, no overshoot) and
// cut the stagger intervals roughly in half. The cascade is still visible
// (rows don't all pop at once) but the whole thing now completes in well
// under 300ms open, ~200ms close — the "unfurl" character survives, the
// lag doesn't.
const listVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.014, staggerDirection: -1 } },
  exit: { transition: { staggerChildren: 0.01, staggerDirection: 1 } },
};
const rowVariants = {
  hidden: { opacity: 0, y: 10, scale: 0.94 },
  visible: { opacity: 1, y: 0, scale: 1, transition: quickSpring },
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
  const MIN_EDGE_INSET = 12;
  // Panel geometry is fixed/deterministic (one row height, one gap, one
  // padding — see Row/listVariants below), so its height can be computed
  // analytically instead of measured after render.
  const PANEL_WIDTH = 208;
  const ROW_HEIGHT = 48; // h-12
  const ROW_GAP = 4; // gap-1
  const PANEL_PADDING = 16; // p-2, top+bottom
  const rowCount = DUO_HUB_ITEMS.length + (onLoveLetter ? 1 : 0) + (onScheduledMessage ? 1 : 0);
  const desiredPanelHeight = rowCount * ROW_HEIGHT + Math.max(0, rowCount - 1) * ROW_GAP + PANEL_PADDING;

  // REPEAT BUG FIX (menu still opening away from the hub button —
  // reproduced on Samsung Internet with the address bar visible): the
  // previous two fixes here (see the surviving comments below, kept as
  // history) both anchored the panel with a CSS `bottom` value computed by
  // SUBTRACTING the button's rect from a separately-measured viewport/
  // container height (`window.innerHeight`, then a portal container's
  // `getBoundingClientRect().bottom`). Both are two independent
  // measurements that have to agree for the subtraction to be correct —
  // and on a mobile browser with a dynamic/collapsing toolbar, the
  // "container" (a `position:fixed; inset:0` div) and the button (a normal
  // in-flow element inside the composer) are not guaranteed to be laid out
  // against the identical visible-viewport rect at every moment, especially
  // right as the toolbar is showing/hiding — which is exactly what put the
  // panel up near the browser chrome instead of over the button.
  //
  // Fixed by dropping the subtraction entirely: anchor with `top`/`left`
  // (not `bottom`/`right`), computed ONLY from the button's own
  // getBoundingClientRect() — one measurement, in one coordinate space,
  // with nothing to reconcile against a second reported size. The panel's
  // height is known analytically (see above) so `top` can be placed
  // directly above the button without ever needing to know the viewport's
  // height at all.
  interface Anchor { top: number; left: number; maxHeight: number }
  const measureAnchor = (): Anchor => {
    if (typeof window === "undefined") return { top: 96, left: MIN_EDGE_INSET, maxHeight: desiredPanelHeight };
    const btn = document.getElementById("chat-hub-button");
    // defensive fallback, shouldn't happen — button is always mounted before Hub can be opened
    if (!btn) return { top: 96, left: MIN_EDGE_INSET, maxHeight: desiredPanelHeight };
    const rect = btn.getBoundingClientRect();
    // Clamp so the panel never gets pushed above the visible top edge
    // (status bar / browser chrome) — shrinks via maxHeight + internal
    // scroll (see the panel's style below) rather than clipping.
    const availableAbove = Math.max(0, rect.top - GAP_ABOVE_BUTTON - MIN_EDGE_INSET);
    const height = Math.min(desiredPanelHeight, availableAbove);
    return {
      top: Math.max(MIN_EDGE_INSET, rect.top - GAP_ABOVE_BUTTON - height),
      // Panel's right edge lines up with the button's right edge, expressed
      // as `left` (both measured from the same left-hand edge as
      // getBoundingClientRect(), so no viewport-width subtraction needed
      // either), clamped so it can never cross the opposite screen edge.
      left: Math.max(MIN_EDGE_INSET, rect.right - PANEL_WIDTH),
      maxHeight: height,
    };
  };
  const [anchor, setAnchor] = useState<Anchor>(measureAnchor);

  useLayoutEffect(() => {
    const recompute = () => setAnchor(measureAnchor());
    recompute();
    // A second recompute one frame later catches any layout that only
    // settles after this first paint (e.g. the composer's own
    // padding-bottom transition triggered by the tap that opened this
    // menu, which the effect above can otherwise win a race against).
    const raf = requestAnimationFrame(recompute);
    window.addEventListener("resize", recompute);
    window.visualViewport?.addEventListener("resize", recompute);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", recompute);
      window.visualViewport?.removeEventListener("resize", recompute);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Escape closes the hub — the backdrop's click-to-dismiss (below) isn't
  // reachable from a keyboard/screen reader, so without this the menu had
  // no keyboard-accessible way to close at all once opened.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") { onClose(); } };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Defer navigation until after the close/exit animation so the sheet
  // gracefully dismisses before the route changes.
  const runThenClose = (fn: () => void) => {
    onClose();
    window.setTimeout(fn, 140);
  };

  // TYPE FIX: these entries merge with DUO_HUB_ITEMS-derived rows (whose
  // icon type is LucideIcon) into one list rendered by Row — typing them as
  // the wider React.ElementType made that merge a compile error.
  const actionItems = [
    onLoveLetter && { icon: Feather, label: "Love Letter", action: () => runThenClose(onLoveLetter) },
    onScheduledMessage && { icon: Clock, label: "Schedule Send", action: () => runThenClose(onScheduledMessage) },
  ].filter(Boolean) as { icon: LucideIcon; label: string; action: () => void }[];

  const frequent = frequentItems.map(i => ({
    icon: i.icon, label: i.label, action: () => { runThenClose(() => navigate(i.path)); },
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
      onClick={() => { onClose(); }}
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
        // PERF FIX: gentlePanelSpring here (stiffness 320/damping 32/mass 1)
        // was tuned for larger surfaces and took ~250ms to settle on open,
        // and — worse — being a spring on `exit` too, AnimatePresence had to
        // wait for it to naturally settle before unmounting, which is what
        // made closing feel sluggish rather than instant. quickSpring on
        // open keeps a touch of physicality without the wait; a fixed
        // microTransition on exit gives AnimatePresence an exact, short
        // duration to wait for instead of an open-ended spring settle.
        initial={{ opacity: 0, scale: 0.85, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0, transition: quickSpring }}
        exit={{ opacity: 0, scale: 0.9, y: 6, transition: microTransition }}
        style={{
          // Anchored on BOTH axes by a single live measurement of the hub
          // button's own rect (see measureAnchor) — `position: fixed` so
          // this is relative to the real viewport directly, with no
          // separate container/viewport-size measurement to go out of sync
          // with. The menu reads as growing out of the button whether the
          // dock is showing/hidden, the keyboard is up, or the device
          // rotates.
          transformOrigin: "bottom right",
          top: anchor.top,
          left: anchor.left,
          // FIX (panel clipped under the browser/status bar): `top` is
          // already clamped in measureAnchor so it can't go above the
          // visible top edge — maxHeight (also computed there) shrinks the
          // panel to fit the actual available space instead, scrolling
          // internally so every row stays reachable regardless of viewport
          // height or item count.
          maxHeight: anchor.maxHeight,
          overflowY: "auto",
        }}
        // AUDIT FIX (Phase 7, cross-cutting radius sweep): was
        // `rounded-[26px]` — a hand-written duplicate of the exact value
        // `--radius-floating` already exists for ("floating: composer,
        // attach tray, dock" per index.css's own radius-scale comment).
        // This IS the attach-tray/hub menu the token's own description
        // names — MessageComposer.tsx already uses `rounded-floating`
        // (see its neighboring comment), this was the one place still
        // spelling the same value out by hand instead of using it.
        className="fixed w-[208px] rounded-floating p-2 glass-hub"
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

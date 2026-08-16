import React, { useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { Image, MapPin, Music, Heart, BookOpen, Feather, Clock, Sparkles, X } from "lucide-react";
import { hapticLight, hapticSelection } from "@/lib/haptics";
import { useLongPress } from "@/hooks/useLongPress";
import { gentlePanelSpring, standardTransition, microTransition } from "@/lib/motion";

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


// Everything that isn't one of the bottom bar's 2 tabs (Chat, Calls) lives
// here instead. Music points at /groic — the unified music + listen-together
// hub (saved playlists still open via /playlist as a deep link, but /groic
// is the entry point everywhere else now).
//
// Frequent = things a couple opens often (Gallery, Music); everything else
// is more occasional/ceremonial. Both tiers render as fixed-geometry grid
// tiles — same width, same height, same icon-container size — the
// hierarchy comes from tier styling (accent tint + slightly larger icon on
// Frequent), never from ad hoc per-item sizing.
const frequentItems = [
  { path: "/gallery", icon: Image, label: "Gallery" },
  { path: "/groic", icon: Music, label: "Music" },
];
const moreItems = [
  { path: "/us", icon: Heart, label: "Us" },
  { path: "/map", icon: MapPin, label: "Map" },
  { path: "/shayari", icon: BookOpen, label: "Shayari" },
];

const GridMenu = ({ onClose, onScheduledMessage, onLoveLetter }: GridMenuProps) => {
  const navigate = useNavigate();

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

  // One consistent tile geometry for every item in both tiers — same
  // height, same icon-well size, same radius. Tier hierarchy comes from
  // background/icon-color treatment only, never from differently-sized
  // boxes.
  const Tile = ({ item, prominent }: { item: typeof frequent[number]; prominent: boolean }) => {
    const Icon = item.icon;
    return (
      <button
        role="menuitem"
        onClick={item.action}
        className={`flex flex-col items-center justify-center gap-1.5 h-20 rounded-2xl transition-[background-color,transform] active:scale-[0.97] ${
          prominent
            ? "bg-primary/10 hover:bg-primary/14 border border-primary/20"
            : "bg-foreground/[0.03] hover:bg-foreground/[0.06] border border-border/40"
        }`}
      >
        <span className={`h-9 w-9 rounded-full flex items-center justify-center ${prominent ? "bg-primary/15" : "bg-muted/70"}`}>
          <Icon className={prominent ? "h-[18px] w-[18px] text-primary" : "h-[16px] w-[16px] text-foreground/75"} aria-hidden="true" />
        </span>
        <span className={`text-[11px] font-medium whitespace-nowrap ${prominent ? "text-foreground" : "text-foreground/80"}`}>
          {item.label}
        </span>
      </button>
    );
  };

  return (
    <motion.div
      // FIX ("aggressive full-screen dark overlay... feels like a modal
      // interruption"): was bg-background/40 + backdrop-blur-[2px]. This
      // is a click-catcher and a very light environmental dim, not a
      // scrim — the user should still feel like they're looking at Chat,
      // just with a panel in front of it.
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={microTransition}
      className="fixed inset-0 z-50 bg-background/10"
      onClick={() => { hapticLight(); onClose(); }}
    >
      {/* FIX (panel geometry + positioning): replaced the vertical stack of
          independently-rotated, mismatched-width pills with one glass
          panel of fixed, predictable geometry, anchored bottom-right near
          the hub button. Position is expressed via --dock-reserve (the
          same token AppLayout already uses to know how much space the
          dock+its gap occupy) rather than a re-guessed magic pixel value —
          if the dock's own height/gap tokens ever change, this stays
          correct automatically instead of drifting out of sync. */}
      <motion.div
        id="chat-hub-menu"
        role="menu"
        aria-label="Shared features"
        initial={{ opacity: 0, scale: 0.85, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.9, y: 6 }}
        transition={gentlePanelSpring}
        style={{
          transformOrigin: "bottom right",
          bottom: "calc(env(safe-area-inset-bottom, 0px) + var(--dock-reserve) + 12px)",
        }}
        className="absolute right-3 w-[min(296px,calc(100vw-24px))] rounded-[28px] p-3 glass-hub"
        onClick={(e) => e.stopPropagation()}
      >
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...standardTransition, delay: 0.04 }}
        >
          <p className="text-[10px] font-semibold uppercase tracking-wider text-primary/80 px-1 pb-2">Together</p>
          <div className="grid grid-cols-2 gap-2">
            {frequent.map((item) => <Tile key={item.label} item={item} prominent />)}
          </div>
          <div className="grid grid-cols-2 gap-2 mt-2">
            {more.map((item) => <Tile key={item.label} item={item} prominent={false} />)}
          </div>
        </motion.div>
      </motion.div>
    </motion.div>
  );
};


export default GridMenu;

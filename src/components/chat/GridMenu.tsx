import React from "react";
import { motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { Image, MapPin, Music, Heart, BookOpen, Feather, Clock, Sparkles } from "lucide-react";
import { hapticLight } from "@/lib/haptics";
import { useLongPress } from "@/hooks/useLongPress";

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
      whileTap={{ scale: 0.88 }}
      animate={{
        scale: isOpen ? 1.05 : 1,
        backgroundColor: isOpen ? "hsl(var(--primary))" : "hsl(var(--muted))",
      }}
      transition={{ type: "spring", stiffness: 380, damping: 22 }}
      aria-label="Open shared features"
      aria-expanded={isOpen}
      id="chat-hub-button"
      className="h-10 w-10 rounded-full flex items-center justify-center shrink-0 relative overflow-hidden"
    >
      {/* Open = clockwise sweep to 90°, close = the same arc unwinding back
          to 0° (not a mirrored/negative spin) — this is the button's own
          half of the "clockwise open / anticlockwise close" motion; the
          popover list underneath echoes it per-item. */}
      <motion.div
        animate={{ rotate: isOpen ? 90 : 0 }}
        transition={{ type: "spring", stiffness: 260, damping: 20 }}
      >
        <Sparkles className={`h-4 w-4 transition-colors ${isOpen ? "text-primary-foreground" : "text-foreground"}`} />
      </motion.div>
    </motion.button>
  );
};


// Everything that isn't one of the bottom bar's 3 pages (Chat, Calls,
// Settings) lives here instead. Music points at /groic — the unified
// music + listen-together hub (saved playlists still open via /playlist
// as a deep link, but /groic is the entry point everywhere else now).
const navItems = [
  { path: "/gallery", icon: Image, label: "Gallery" },
  { path: "/map", icon: MapPin, label: "Map" },
  { path: "/groic", icon: Music, label: "Music" },
  { path: "/shayari", icon: BookOpen, label: "Shayari" },
  { path: "/us", icon: Heart, label: "Us" },
];

// FIX (Hub redesign): the hub used to open as a full-width bottom sheet in a
// 4-column grid, completely disconnected from the sparkle button that
// triggered it. Now it opens as a vertical list of pills directly above the
// hub button (which lives at the right edge of the composer), so it visibly
// unfurls *from* the button instead of sliding up from an unrelated edge.
// Each item sweeps in on a clockwise arc (rotate -26° → 0°, matching the
// button's own 0° → 90° open spin) and sweeps back out anticlockwise on
// close (rotate 0° → 26°), staggered bottom-to-top so it reads as a single
// fan unfurling near the button rather than a generic list fade.
const ITEM_ROTATE_DEG = 26;

const GridMenu = ({ onClose, onScheduledMessage, onLoveLetter }: GridMenuProps) => {
  const navigate = useNavigate();

  // Defer navigation until after the close/exit animation so the sheet
  // gracefully dismisses before the route changes.
  const runThenClose = (fn: () => void) => {
    hapticLight();
    onClose();
    window.setTimeout(fn, 160);
  };

  const actionItems = [
    onLoveLetter && { icon: Feather, label: "Love Letter", action: () => runThenClose(onLoveLetter) },
    onScheduledMessage && { icon: Clock, label: "Schedule Send", action: () => runThenClose(onScheduledMessage) },
  ].filter(Boolean) as { icon: React.ElementType; label: string; action: () => void }[];

  const allItems = [...actionItems, ...navItems.map(i => ({
    icon: i.icon,
    label: i.label,
    action: () => runThenClose(() => navigate(i.path)),
  }))];

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16 }}
      className="fixed inset-0 z-50 bg-background/40 backdrop-blur-[2px]"
      onClick={() => { hapticLight(); onClose(); }}
    >
      {/* Anchored above-right of the hub button — bottom offset clears the
          composer bar + safe area, right offset roughly aligns the column
          with the button itself (both live in the same px-3 padded row). */}
      <div
        className="absolute right-4 flex flex-col items-end gap-2"
        style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 78px)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {allItems.map((item, i) => {
          const Icon = item.icon;
          const isAction = i < actionItems.length;
          // Reverse index so the item closest to the hub button (last in
          // the list, bottom of the stack) animates first — the fan opens
          // outward from the button and closes back into it.
          const order = allItems.length - 1 - i;
          return (
            <motion.button
              key={item.label}
              initial={{ opacity: 0, scale: 0.5, x: 14, rotate: -ITEM_ROTATE_DEG }}
              animate={{ opacity: 1, scale: 1, x: 0, rotate: 0 }}
              exit={{ opacity: 0, scale: 0.5, x: 14, rotate: ITEM_ROTATE_DEG }}
              transition={{
                type: "spring", stiffness: 420, damping: 28,
                delay: order * 0.035,
              }}
              style={{ transformOrigin: "bottom right" }}
              whileTap={{ scale: 0.94 }}
              onClick={item.action}
              className="flex items-center gap-2.5 pl-3.5 pr-2 py-2 rounded-full bg-card/95 backdrop-blur-md border border-border/40 shadow-[0_6px_20px_-6px_hsl(var(--foreground)/0.25)]"
            >
              <span className="text-xs font-medium text-foreground/85 whitespace-nowrap">{item.label}</span>
              <span className={`h-8 w-8 rounded-full flex items-center justify-center shrink-0 ${
                isAction ? "bg-primary/12" : "bg-muted/70"
              }`}>
                <Icon className={`h-[16px] w-[16px] ${isAction ? "text-primary" : "text-foreground/75"}`} />
              </span>
            </motion.button>
          );
        })}
      </div>
    </motion.div>
  );
};


export default GridMenu;

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
      className="h-10 w-10 rounded-full flex items-center justify-center shrink-0 relative overflow-hidden"
    >
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
      transition={{ duration: 0.18 }}
      className="fixed inset-0 z-50 bg-background/50 backdrop-blur-sm flex items-end justify-center"
      onClick={() => { hapticLight(); onClose(); }}
    >
      <motion.div
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={{ type: "spring", stiffness: 380, damping: 34 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-t-[28px] bg-card/95 backdrop-blur-md border-t border-border/20 pt-2.5 pb-6 safe-bottom"
        style={{ boxShadow: "var(--shadow-soft)" }}
      >
        {/* Drag handle */}
        <div className="flex justify-center pb-4">
          <span className="h-1 w-9 rounded-full bg-border" />
        </div>

        <div className="grid grid-cols-4 gap-x-2 gap-y-5 px-5">
          {allItems.map((item, i) => {
            const Icon = item.icon;
            const isAction = i < actionItems.length;
            return (
              <motion.button
                key={item.label}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.02, duration: 0.18 }}
                whileTap={{ scale: 0.92 }}
                onClick={item.action}
                className="flex flex-col items-center gap-1.5"
              >
                <span className={`h-14 w-14 rounded-2xl flex items-center justify-center backdrop-blur-sm ${
                  isAction ? "bg-primary/10" : "bg-muted/60"
                }`}>
                  <Icon className={`h-[22px] w-[22px] ${isAction ? "text-primary" : "text-foreground/80"}`} />
                </span>
                <span className="text-[11px] font-medium text-foreground/80 text-center leading-tight">{item.label}</span>
              </motion.button>
            );
          })}
        </div>
      </motion.div>
    </motion.div>
  );
};


export default GridMenu;

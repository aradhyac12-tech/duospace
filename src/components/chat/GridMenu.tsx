import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { Image, MapPin, Music, Heart, X, BookOpen, Feather, Clock, Sparkles } from "lucide-react";
import { hapticLight } from "@/lib/haptics";

interface GridMenuProps {
  onClose: () => void;
  // F3, F4: callbacks for chat-specific actions
  onScheduledMessage?: () => void;
  onLoveLetter?: () => void;
}

interface HubButtonProps {
  onClick: () => void;
  isOpen: boolean;
}

export const HubButton = ({ onClick, isOpen }: HubButtonProps) => (
  <motion.button
    onClick={onClick}
    whileTap={{ scale: 0.88 }}
    animate={{
      scale: isOpen ? 1.05 : 1,
      backgroundColor: isOpen ? "hsl(var(--foreground))" : "hsl(var(--muted))",
    }}
    transition={{ type: "spring", stiffness: 380, damping: 22 }}
    className="h-10 w-10 rounded-full flex items-center justify-center shrink-0 relative overflow-hidden"
  >
    <motion.div
      animate={{ rotate: isOpen ? 180 : 0 }}
      transition={{ type: "spring", stiffness: 260, damping: 20 }}
    >
      <Sparkles className={`h-4 w-4 transition-colors ${isOpen ? "text-background" : "text-foreground"}`} />
    </motion.div>
  </motion.button>
);


const navItems = [
  { path: "/gallery", icon: Image, label: "Gallery" },
  { path: "/map", icon: MapPin, label: "Map" },
  { path: "/playlist", icon: Music, label: "Music" },
  { path: "/shayari", icon: BookOpen, label: "Shayari" },
  { path: "/us", icon: Heart, label: "Us" },
];

const GridMenu = ({ onClose, onScheduledMessage, onLoveLetter }: GridMenuProps) => {
  const navigate = useNavigate();

  // Defer navigation until after the close/exit animation so the outgoing
  // tiles gracefully fly away before the route changes.
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
      animate={{ opacity: 1, backdropFilter: "blur(6px)" }}
      exit={{ opacity: 0, backdropFilter: "blur(0px)" }}
      transition={{ duration: 0.18 }}
      className="fixed inset-0 z-50 bg-background/40"
      onClick={onClose}
    >
      <div className="absolute bottom-[4.25rem] right-3 flex flex-col items-end gap-2" onClick={(e) => e.stopPropagation()}>
        <motion.button
          initial={{ opacity: 0, y: 8, scale: 0.9 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.9 }}
          transition={{ type: "spring", stiffness: 400, damping: 24 }}
          whileTap={{ scale: 0.9 }}
          onClick={onClose}
          className="h-9 w-9 rounded-full bg-card border border-border/50 shadow-lg flex items-center justify-center"
        >
          <X className="h-4 w-4 text-muted-foreground" />
        </motion.button>

        <div className="flex flex-col items-end gap-2">
          {allItems.map((item, i) => {
            const Icon = item.icon;
            const isAction = i < actionItems.length;
            const total = allItems.length;
            return (
              <motion.button
                key={item.label}
                initial={{ opacity: 0, x: 40, scale: 0.85 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={{ opacity: 0, x: 32, scale: 0.85, transition: { delay: (total - 1 - i) * 0.025, duration: 0.14 } }}
                transition={{ delay: i * 0.035, type: "spring", stiffness: 380, damping: 24 }}
                whileTap={{ scale: 0.94 }}
                whileHover={{ x: -2 }}
                onClick={item.action}
                className={`flex items-center gap-3 rounded-full border shadow-lg px-3 py-2 min-w-[148px] ${
                  isAction
                    ? "bg-foreground border-foreground/20 text-background"
                    : "bg-card/95 backdrop-blur-sm border-border/50"
                }`}
              >
                <div className={`h-9 w-9 rounded-full flex items-center justify-center shrink-0 ${isAction ? "bg-white/10" : "bg-muted"}`}>
                  <Icon className={`h-4 w-4 ${isAction ? "text-background" : "text-foreground"}`} />
                </div>
                <span className={`text-xs font-medium ${isAction ? "text-background" : "text-foreground"}`}>{item.label}</span>
              </motion.button>
            );
          })}
        </div>
      </div>
    </motion.div>
  );
};


export default GridMenu;

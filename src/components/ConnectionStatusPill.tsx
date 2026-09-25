import { motion, AnimatePresence } from "framer-motion";
import { Loader2, Check, WifiOff } from "lucide-react";
import type { ConnectionStatus } from "@/hooks/useAppNative";

interface ConnectionStatusPillProps {
  status: ConnectionStatus;
}

// Small centered pill (Lovable-style status chip) instead of a full-width
// banner — shows three transient states as connectivity changes:
//   "offline"      → stays up the whole time we're definitely offline
//   "reconnecting" → spinner pill right after connectivity returns
//   "connected"    → brief check-mark confirmation, then disappears
// null means idle/steady-state online — nothing rendered.
//
// Styling: one uniform glass pill (10%-opacity tint, heavy blur, hairline
// border, soft top sheen) for all three states — status is communicated by
// the icon's color, not by swapping the pill's own background, so the
// glass reads consistently as the connection recovers.
const ConnectionStatusPill = ({ status }: ConnectionStatusPillProps) => {
  const config = status === "offline"
    ? { icon: <WifiOff className="h-3.5 w-3.5" aria-hidden="true" />, label: "Offline — showing saved data", iconTone: "text-offline" }
    : status === "reconnecting"
    ? { icon: <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />, label: "Reconnecting…", iconTone: "text-foreground/70" }
    : status === "connected"
    ? { icon: <Check className="h-3.5 w-3.5" aria-hidden="true" />, label: "Connected", iconTone: "text-success" }
    : null;

  return (
    <div className="pointer-events-none fixed top-0 left-0 right-0 z-[9998] flex justify-center safe-top pt-3">
      <AnimatePresence>
        {config && (
          <motion.div
            key={status}
            initial={{ y: -18, opacity: 0, scale: 0.92 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: -14, opacity: 0, scale: 0.94 }}
            transition={{ type: "spring", stiffness: 480, damping: 30, mass: 0.7 }}
            role="status"
            aria-live="polite"
            className="pointer-events-auto flex items-center gap-2 rounded-full px-4 py-2 text-xs font-medium text-foreground bg-white/10 border border-white/25 backdrop-blur-xl backdrop-saturate-150 shadow-[0_8px_24px_-6px_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.25)]"
          >
            <span className={config.iconTone}>{config.icon}</span>
            <span>{config.label}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default ConnectionStatusPill;

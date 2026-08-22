import { motion } from "framer-motion";
import { PhoneOff } from "lucide-react";
import { hapticMedium, hapticLight } from "@/lib/haptics";
import { quickSpring } from "@/lib/motion";

/**
 * Full-screen "call failed" state — shown when callState === "error".
 * Extracted from Calls.tsx (DA-02) alongside CallOutcomeScreen and
 * CallStatusBanner, which this completes the pattern with: all three are
 * self-contained, purely presentational call-screen states that take
 * simple props/callbacks rather than reaching into Calls.tsx's own
 * WebRTC/Daily state directly.
 */
export function CallErrorScreen({
  error, onRetry, onBack,
}: { error: string | null; onRetry: () => void; onBack: () => void }) {
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      role="alert"
      className="fixed inset-0 z-[90] flex flex-col items-center justify-center gap-4 bg-destructive/10 px-6 safe-top safe-bottom">
      <PhoneOff className="h-12 w-12 text-destructive" aria-hidden="true" />
      <div className="text-center space-y-1 max-w-xs">
        <p className="text-base font-semibold text-foreground">Call failed</p>
        {error && <p className="text-sm text-muted-foreground">{error}</p>}
      </div>
      {/* MICRO-DETAIL: matching CallOutcomeScreen's press-feedback fix —
          same quickSpring whileTap on both actions, same reasoning. */}
      <div className="flex items-center gap-3">
        <motion.button onClick={() => { hapticMedium(); onRetry(); }}
          whileTap={{ scale: 0.96 }} transition={quickSpring}
          className="h-11 px-5 rounded-full bg-primary text-primary-foreground text-sm font-medium">
          Try again
        </motion.button>
        <motion.button onClick={() => { hapticLight(); onBack(); }}
          whileTap={{ scale: 0.96 }} transition={quickSpring}
          className="h-11 px-5 rounded-full bg-muted text-foreground text-sm font-medium">
          Back to Calls
        </motion.button>
      </div>
    </motion.div>
  );
}

export default CallErrorScreen;

import { useEffect } from "react";
import { motion } from "framer-motion";
import { PhoneMissed, PhoneOff, RotateCcw, X } from "lucide-react";
import { hapticLight, hapticMedium, hapticWarning } from "@/lib/haptics";
import { quickSpring } from "@/lib/motion";
import type { CallOutcome } from "@/lib/callUiState";

interface CallOutcomeScreenProps {
  outcome: CallOutcome;
  partnerName: string;
  /** Primary action — start a new call the same way this one was started. */
  onCallAgain: () => void;
  onDismiss: () => void;
  /** Auto-return to the call hub after this long (ms). Set 0 to disable. */
  autoDismissMs?: number;
}

const AUTO_DISMISS_DEFAULT = 5000;

/**
 * Every terminal call outcome the caller can hit before the call ever
 * connects, rendered as one explicit screen instead of a bare toast:
 * correct primary action (call again), correct secondary action
 * (dismiss / message instead), a11y labels, and a haptic that matches an
 * outcome the person didn't choose (hapticWarning, not hapticError — this
 * isn't a bug, it's a normal thing that happens on calls).
 */
const CallOutcomeScreen = ({ outcome, partnerName, onCallAgain, onDismiss, autoDismissMs = AUTO_DISMISS_DEFAULT }: CallOutcomeScreenProps) => {
  useEffect(() => {
    hapticWarning();
  }, [outcome]);

  useEffect(() => {
    if (!autoDismissMs) return;
    const t = setTimeout(onDismiss, autoDismissMs);
    return () => clearTimeout(t);
  }, [autoDismissMs, onDismiss]);

  const { title, subtitle, Icon } = (() => {
    switch (outcome.type) {
      case "no-answer":
        return { title: `${partnerName} didn't answer`, subtitle: "They may be busy right now.", Icon: PhoneMissed };
      case "cancelled-elsewhere":
        return { title: "Call ended", subtitle: "Cancelled from another device.", Icon: PhoneOff };
      case "failed":
        return { title: "Call couldn't connect", subtitle: outcome.message, Icon: PhoneOff };
    }
  })();

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      role="status" aria-live="polite"
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-6 bg-call-stage px-8 safe-top safe-bottom"
    >
      {/* MICRO-DETAIL: this screen's three controls were plain <button>s
          with no press feedback at all — every other terminal-state
          screen's controls in the app (dock, composer, grid menu) use the
          shared quickSpring whileTap. Brought these in line rather than
          leaving the call-outcome screen as the one place a tap doesn't
          visibly respond before the haptic/action fires. */}
      <motion.button onClick={() => { hapticLight(); onDismiss(); }} aria-label="Close"
        whileTap={{ scale: 0.94 }} transition={quickSpring}
        className="absolute top-6 right-6 h-10 w-10 rounded-full bg-call-stage-foreground/10 flex items-center justify-center">
        <X className="h-4 w-4 text-call-stage-foreground/70" aria-hidden="true" />
      </motion.button>

      <div className="h-16 w-16 rounded-full bg-call-stage-foreground/10 flex items-center justify-center">
        <Icon className="h-7 w-7 text-call-stage-foreground/70" aria-hidden="true" />
      </div>
      <div className="text-center space-y-1.5 max-w-xs">
        <p className="text-lg font-medium text-call-stage-foreground">{title}</p>
        {subtitle && <p className="text-sm text-call-stage-foreground/50">{subtitle}</p>}
      </div>

      <div className="flex items-center gap-3 pt-2">
        <motion.button onClick={() => { hapticMedium(); onCallAgain(); }}
          whileTap={{ scale: 0.96 }} transition={quickSpring}
          className="h-11 px-5 rounded-full bg-primary text-primary-foreground text-sm font-medium flex items-center gap-2">
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
          Call again
        </motion.button>
        <motion.button onClick={() => { hapticLight(); onDismiss(); }}
          whileTap={{ scale: 0.96 }} transition={quickSpring}
          className="h-11 px-5 rounded-full bg-call-stage-foreground/10 text-call-stage-foreground text-sm font-medium">
          Back
        </motion.button>
      </div>
    </motion.div>
  );
};

export default CallOutcomeScreen;

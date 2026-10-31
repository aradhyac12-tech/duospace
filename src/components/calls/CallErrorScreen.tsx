import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { PhoneOff } from "lucide-react";
import { hapticMedium } from "@/lib/haptics";
import { quickSpring } from "@/lib/motion";
import type { CallError } from "@/lib/callErrors";
import { errorManager } from "@/lib/errors";
import type { DuoSpaceErrorPayload } from "@/lib/errors";
import { ErrorCard } from "@/components/errors/ErrorCard";

/**
 * Full-screen "call failed" state — shown when callState === "error".
 * Extracted from Calls.tsx (DA-02) alongside CallOutcomeScreen and
 * CallStatusBanner, which this completes the pattern with: all three are
 * self-contained, purely presentational call-screen states that take
 * simple props/callbacks rather than reaching into Calls.tsx's own
 * WebRTC/the call engine state directly.
 *
 * IN-APP ERROR SYSTEM WIRING: when the richer `callError` (from
 * classifyCallError — see src/lib/callErrors.ts) is available, this now
 * (a) logs it into the centralized error system via errorManager.capture
 * using its dsCode (DS-CALL-0xx — see registry.ts), so it shows up in
 * Developer Mode's error log/export like every other error in the app, and
 * (b) renders the shared <ErrorCard> instead of a plain string, so a call
 * failure gets the same title/message/recovery-suggestion/retry/copy/report
 * treatment as any other DuoSpace error. Falls back to the original plain
 * text UI when only the legacy `error: string` prop is passed, so nothing
 * that already renders this component breaks.
 */
export function CallErrorScreen({
  error, callError, onRetry, onBack, developerMode = false,
}: {
  error: string | null;
  callError?: CallError | null;
  onRetry: () => void;
  onBack: () => void;
  /** Show raw stack/detail in the card, same convention as ErrorBoundary/ErrorLogPanel. */
  developerMode?: boolean;
}) {
  const [payload, setPayload] = useState<DuoSpaceErrorPayload | null>(null);

  useEffect(() => {
    if (!callError) { setPayload(null); return; }
    // One capture per distinct failure (not per re-render) — captures into
    // errorManager's log store (visible in Developer Mode → error log,
    // exportable) and returns the normalized payload the ErrorCard renders.
    setPayload(errorManager.capture(callError.dsCode, {
      screen: "Calls",
      component: "CallErrorScreen",
      cause: new Error(callError.detail),
      details: { callErrorCode: callError.code, severity: callError.severity },
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callError?.dsCode, callError?.detail]);

  if (callError && payload) {
    return (
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        role="alert"
        className="fixed inset-0 z-[90] flex flex-col items-center justify-center gap-4 bg-destructive/10 px-6 safe-top safe-bottom">
        <div className="w-full max-w-sm">
          <ErrorCard error={payload} onRetry={onRetry} developerMode={developerMode} />
        </div>
        <motion.button onClick={onBack} whileTap={{ scale: 0.96 }} transition={quickSpring}
          className="h-11 px-5 rounded-full bg-muted text-foreground text-sm font-medium">
          Back to Calls
        </motion.button>
      </motion.div>
    );
  }

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
        <motion.button onClick={() => { onBack(); }}
          whileTap={{ scale: 0.96 }} transition={quickSpring}
          className="h-11 px-5 rounded-full bg-muted text-foreground text-sm font-medium">
          Back to Calls
        </motion.button>
      </div>
    </motion.div>
  );
}

export default CallErrorScreen;

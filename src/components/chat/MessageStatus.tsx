import { Check, CheckCheck, Loader2, AlertCircle } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { DUR_FAST } from "@/lib/motion";

interface MessageStatusProps {
  isRead: boolean;
  isMine: boolean;
  /** Optimistic-send state — see DecryptedMessage._sendStatus. Undefined
   *  for every normal, already-persisted message (the common case). */
  sendStatus?: "sending" | "failed";
  /** Only meaningful when sendStatus === "failed" — tap to resend. */
  onRetry?: () => void;
}

// Fix #16: Single check = sent/delivered, double check = read (standard
// convention). Extended for optimistic sending: a small spinner while the
// send/upload is in flight, and a tappable "failed, tap to retry" icon if
// it errored — the WhatsApp-style three/four-state send indicator, instead
// of only ever having "sent" or "read" once a message could even appear.
const MessageStatus = ({ isRead, isMine, sendStatus, onRetry }: MessageStatusProps) => {
  if (!isMine) return null;

  if (sendStatus === "sending") {
    return <Loader2 className="h-3 w-3 inline-block ml-0.5 text-primary-foreground/60 animate-spin motion-reduce:animate-none" aria-label="Sending" />;
  }
  if (sendStatus === "failed") {
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onRetry?.(); }}
        className="inline-flex items-center ml-0.5 -my-1 py-1 text-destructive"
        aria-label="Failed to send, tap to retry"
      >
        <AlertCircle className="h-3 w-3" />
      </button>
    );
  }

  // MICRO-DETAIL: sent→read used to swap instantly (single tick to double
  // tick with no transition). Small AnimatePresence crossfade+scale so the
  // "read" moment reads as a deliberate little confirmation instead of a
  // silent prop change — same DUR_FAST (140ms) token used for every other
  // icon-swap micro-feedback in the app (VoiceMessagePlayer's play/pause,
  // etc.), so it doesn't introduce a new timing value. Purely opacity/scale,
  // so it's already covered by App.tsx's global reduced-motion wrapper.
  return (
    <AnimatePresence mode="wait" initial={false}>
      {isRead ? (
        <motion.span key="read" initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: DUR_FAST }} className="inline-flex ml-0.5">
          <CheckCheck className="h-3.5 w-3.5 text-info" />
        </motion.span>
      ) : (
        <motion.span key="sent" initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: DUR_FAST }} className="inline-flex ml-0.5">
          <Check className="h-3 w-3 text-primary-foreground/50" />
        </motion.span>
      )}
    </AnimatePresence>
  );
};

export default MessageStatus;

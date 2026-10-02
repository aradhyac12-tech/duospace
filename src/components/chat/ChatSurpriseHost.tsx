import type { EngineSurprise } from "@/lib/surpriseEngine";
import type { DualActivationState } from "@/lib/coupleSync";
import SurpriseReveal from "@/components/surprise/SurpriseReveal";

/**
 * Mount ONLY on the chat screen. Purely presentational — the lifecycle
 * (fetching, realtime, deep links, stages) all lives in useChatSurprise,
 * called once by Chat.tsx and threaded down here AND to MessageTimeline's
 * inline SurpriseMessage rows. Two independent useChatSurprise() instances
 * would double-subscribe to realtime and could disagree about which
 * surprise is open, so this deliberately owns nothing itself anymore.
 */
interface ChatSurpriseHostProps {
  surprise: EngineSurprise | null;
  visible: boolean;
  close: (engaged?: boolean) => void;
  /** §7: dual-activation state for THIS surprise, if any — undefined is a
   *  valid "not yet known" state (first fetch hasn't landed), same as
   *  {mine:false,partner:false,both:false} to SurpriseReveal. */
  dualActivation?: DualActivationState;
  /** §8 (Living Photograph): bumped counter → one-shot ripple into the frame. */
  rippleTick?: number;
}

const ChatSurpriseHost = ({ surprise, visible, close, dualActivation, rippleTick }: ChatSurpriseHostProps) => {
  if (!surprise) return null;
  return <SurpriseReveal surprise={surprise} visible={visible} onClose={close} dualActivation={dualActivation} rippleTick={rippleTick} />;
};

export default ChatSurpriseHost;

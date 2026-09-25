import type { EngineSurprise } from "@/lib/surpriseEngine";
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
  close: () => void;
}

const ChatSurpriseHost = ({ surprise, visible, close }: ChatSurpriseHostProps) => {
  if (!surprise) return null;
  return <SurpriseReveal surprise={surprise} visible={visible} onClose={close} />;
};

export default ChatSurpriseHost;

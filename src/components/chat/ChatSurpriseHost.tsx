import { useChatSurprise } from "@/hooks/useChatSurprise";
import SurpriseReveal from "@/components/surprise/SurpriseReveal";

/**
 * Mount ONLY on the chat screen. Owns nothing global, fires nothing on
 * app startup — the delayed check inside useChatSurprise only starts once
 * this component (and therefore the chat screen) is alive.
 */
const ChatSurpriseHost = () => {
  const { surprise, visible, close } = useChatSurprise();
  if (!surprise) return null;
  return <SurpriseReveal surprise={surprise} visible={visible} onClose={close} />;
};

export default ChatSurpriseHost;

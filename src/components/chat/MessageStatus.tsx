import { Check, CheckCheck } from "lucide-react";

interface MessageStatusProps {
  isRead: boolean;
  isMine: boolean;
}

// Fix #16: Single check = sent/delivered, double check = read (standard convention)
const MessageStatus = ({ isRead, isMine }: MessageStatusProps) => {
  if (!isMine) return null;
  if (isRead) {
    return <CheckCheck className="h-3.5 w-3.5 inline-block ml-0.5 text-blue-400" />;
  }
  // Single tick = sent but not yet read
  return <Check className="h-3 w-3 inline-block ml-0.5 text-background/40" />;
};

export default MessageStatus;

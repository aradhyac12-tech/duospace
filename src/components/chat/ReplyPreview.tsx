import { X, Reply } from "lucide-react";
import { motion } from "framer-motion";

interface ReplyPreviewProps {
  replyToContent: string;
  replyToSenderName: string;
  onCancel: () => void;
}

const ReplyPreview = ({ replyToContent, replyToSenderName, onCancel }: ReplyPreviewProps) => (
  <motion.div
    initial={{ opacity: 0, y: 10 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: 10 }}
    className="px-4 pb-1"
  >
    <div className="flex items-center gap-2 bg-card rounded-xl border border-border px-3 py-2 shadow-sm">
      <Reply className="h-4 w-4 text-primary shrink-0" />
      <div className="flex-1 min-w-0 border-l-2 border-primary pl-2">
        <p className="text-[11px] font-medium text-primary truncate">{replyToSenderName}</p>
        <p className="text-xs text-muted-foreground truncate">{replyToContent}</p>
      </div>
      <button onClick={onCancel} className="h-6 w-6 rounded-full flex items-center justify-center hover:bg-muted transition-colors shrink-0">
        <X className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
    </div>
  </motion.div>
);

export default ReplyPreview;

import { motion } from "framer-motion";
import { Pin } from "lucide-react";
import { hapticLight } from "@/lib/haptics";
import type { DecryptedMessage } from "@/types/chat";

// ─── PinnedMessageBanner ────────────────────────────────────────────────────
// Pure presentational component — extracted unchanged from pages/Chat.tsx
// (Phase 3 UI/state decomposition).
const PinnedMessageBanner = ({ msg, onJump }: { msg: DecryptedMessage; onJump: () => void }) => (
  <motion.button
    initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
    exit={{ height: 0, opacity: 0 }}
    onClick={() => { hapticLight(); onJump(); }}
    className="w-full px-4 py-2 bg-primary/5 border-b border-primary/10 flex items-center gap-2 text-left"
  >
    <Pin className="h-3 w-3 text-primary shrink-0" />
    <div className="flex-1 min-w-0">
      <p className="text-[10px] text-primary font-medium">Pinned message</p>
      <p className="text-[11px] text-foreground truncate">{msg.decryptedContent || "📎 Attachment"}</p>
    </div>
  </motion.button>
);

export default PinnedMessageBanner;

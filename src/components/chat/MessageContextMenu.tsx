import { motion, AnimatePresence } from "framer-motion";
import { Copy, Trash2, Reply, Pencil, Pin, PinOff } from "lucide-react";
import { useCallback } from "react";

interface MessageContextMenuProps {
  isOpen: boolean;
  onClose: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onReply: () => void;
  onEdit?: () => void;
  onPin?: () => void;
  isMine: boolean;
  isPinned?: boolean;
  messageContent: string | null;
  messageType?: string;
}

const MessageContextMenu = ({
  isOpen, onClose, onCopy, onDelete, onReply,
  onEdit, onPin, isMine, isPinned,
  messageContent, messageType,
}: MessageContextMenuProps) => {
  const handle = useCallback((action: () => void) => { action(); onClose(); }, [onClose]);

  const canEdit = isMine && (messageType === "text" || messageType === "letter");

  const actions = [
    { icon: Reply,   label: "Reply",   action: onReply,  show: true },
    { icon: Copy,    label: "Copy",    action: onCopy,   show: !!messageContent && messageType !== "voice" },
    { icon: Pencil,  label: "Edit",    action: onEdit ?? (() => {}), show: canEdit && !!onEdit },
    { icon: isPinned ? PinOff : Pin,
                     label: isPinned ? "Unpin" : "Pin",
                                       action: onPin  ?? (() => {}), show: !!onPin },
    { icon: Trash2,  label: "Delete",  action: onDelete, show: isMine, destructive: true },
  ].filter(a => a.show);

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-[100] bg-foreground/20"
            style={{ backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)" }}
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 10 }}
            transition={{ type: "spring", stiffness: 500, damping: 35 }}
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[101] bg-card border border-border/60 rounded-2xl shadow-xl overflow-hidden min-w-[200px]"
          >
            {actions.map((item, i) => (
              <button key={item.label}
                onClick={() => handle(item.action)}
                className={`w-full flex items-center gap-3 px-4 py-3 text-sm transition-colors active:bg-muted/60 ${
                  i < actions.length - 1 ? "border-b border-border/30" : ""
                } ${item.destructive ? "text-destructive" : "text-foreground"}`}>
                <item.icon className="h-4 w-4" />
                <span>{item.label}</span>
              </button>
            ))}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};

export default MessageContextMenu;

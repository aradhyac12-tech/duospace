import { motion, AnimatePresence } from "framer-motion";
import { Copy, Trash2, Reply, Pencil, Pin, PinOff, SmilePlus } from "lucide-react";
import { useCallback } from "react";
import { hapticSelection, hapticMedium } from "@/lib/haptics";

interface MessageContextMenuProps {
  isOpen: boolean;
  onClose: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onReply: () => void;
  onReact?: () => void;
  onEdit?: () => void;
  onPin?: () => void;
  isMine: boolean;
  isPinned?: boolean;
  messageContent: string | null;
  messageType?: string;
}

// A bottom sheet, not a center-screen dialog — consistent with the rest of
// the app's sheets (GridMenu, attachment sheet) and reachable one-handed
// regardless of where in the scroll the long-pressed message sits.
const MessageContextMenu = ({
  isOpen, onClose, onCopy, onDelete, onReply, onReact,
  onEdit, onPin, isMine, isPinned,
  messageContent, messageType,
}: MessageContextMenuProps) => {
  const handle = useCallback((action: () => void, destructive?: boolean) => {
    (destructive ? hapticMedium : hapticSelection)(); // menu selection → selection tier; destructive → medium
    action();
    onClose();
  }, [onClose]);

  const canEdit = isMine && (messageType === "text" || messageType === "letter");

  const actions = [
    { icon: Reply,     label: "Reply",   action: onReply,                 show: true },
    { icon: SmilePlus, label: "React",   action: onReact ?? (() => {}),   show: !!onReact },
    { icon: Copy,      label: "Copy",    action: onCopy,   show: !!messageContent && messageType !== "voice" },
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
            className="fixed inset-0 z-[100] bg-background/40"
            onClick={onClose}
          />
          <motion.div
            initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
            transition={{ type: "spring", stiffness: 420, damping: 36 }}
            className="fixed inset-x-0 bottom-0 z-[101] flex justify-center"
          >
            <div className="w-full max-w-md bg-card/95 backdrop-blur-md border-t border-border/20 rounded-t-[28px] pt-2.5 pb-2 safe-bottom">
              <div className="flex justify-center pb-2">
                <span className="h-1 w-9 rounded-full bg-border" />
              </div>
              {actions.map((item, i) => (
                <button key={item.label}
                  onClick={() => handle(item.action, item.destructive)}
                  className={`w-full flex items-center gap-3 px-5 py-3.5 text-sm transition-colors active:bg-muted/60 min-h-11 ${
                    i < actions.length - 1 ? "border-b border-border/20" : ""
                  } ${item.destructive ? "text-destructive" : "text-foreground"}`}>
                  <item.icon className="h-[18px] w-[18px]" aria-hidden="true" />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};

export default MessageContextMenu;

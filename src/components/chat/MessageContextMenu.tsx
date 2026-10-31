import { motion, AnimatePresence } from "framer-motion";
import { Copy, Trash2, Reply, Pencil, Pin, PinOff, SmilePlus, Sparkles, Lightbulb } from "lucide-react";
import { useCallback, useEffect } from "react";
import { tr } from "@/lib/i18n";
import { hapticSelection, hapticDeleteMessage, hapticCopy, hapticPin, hapticReplyCommit, hapticReaction } from "@/lib/haptics";

interface MessageContextMenuProps {
  isOpen: boolean;
  onClose: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onReply: () => void;
  onReact?: () => void;
  /** Optional: "Help me reply" (partner's text messages only). Absent = not shown. */
  onHelpReply?: () => void;
  /** Optional: "Understand" (partner's text messages only). Absent = not shown. */
  onUnderstand?: () => void;
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
  messageContent, messageType, onHelpReply, onUnderstand,
}: MessageContextMenuProps) => {
  const handle = useCallback((action: () => void, destructive?: boolean, kind?: "copy" | "pin" | "reply" | "react") => {
    // Each action has its own layered signature; destructive = delete thud-fall.
    if (destructive) hapticDeleteMessage();
    else if (kind === "copy") hapticCopy();
    else if (kind === "pin") hapticPin();
    else if (kind === "reply") hapticReplyCommit();
    else if (kind === "react") hapticReaction();
    else hapticSelection();
    action();
    onClose();
  }, [onClose]);

  // Keyboard / hardware-back parity: Escape closes the menu (does not touch message actions).
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  const canEdit = isMine && (messageType === "text" || messageType === "letter");

  type Item = { icon: typeof Reply; label: string; action: () => void; show: boolean; destructive?: boolean; kind?: "copy" | "pin" | "reply" | "react" };
  const canAI = !isMine && messageType === "text" && !!messageContent?.trim();
  // Conceptual hierarchy: normal actions · Relationship help (secondary) · the rest.
  const groups: Item[][] = [
    [
      { icon: Reply,     label: tr("p1.menu.reply"), action: onReply, show: true, kind: "reply" },
      { icon: SmilePlus, label: tr("p1.menu.react"), action: onReact ?? (() => {}), show: !!onReact, kind: "react" },
      { icon: Copy,      label: tr("p1.menu.copy"),  action: onCopy, show: !!messageContent && messageType !== "voice", kind: "copy" },
    ],
    [
      { icon: Sparkles,  label: tr("p1.ai.helpReply"), action: onHelpReply ?? (() => {}), show: !!onHelpReply && canAI },
      { icon: Lightbulb, label: tr("p1.understand.title"), action: onUnderstand ?? (() => {}), show: !!onUnderstand && canAI },
    ],
    [
      { icon: Pencil, label: tr("p1.menu.edit"), action: onEdit ?? (() => {}), show: canEdit && !!onEdit },
      { icon: isPinned ? PinOff : Pin, label: isPinned ? tr("p1.menu.unpin") : tr("p1.menu.pin"), action: onPin ?? (() => {}), show: !!onPin, kind: "pin" },
      { icon: Trash2, label: tr("p1.menu.delete"), action: onDelete, show: isMine, destructive: true },
    ],
  ].map((g) => g.filter((a) => a.show)).filter((g) => g.length > 0);

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
            <div role="dialog" aria-modal="true"
              className="w-full max-w-md bg-card/95 backdrop-blur-md [@media(prefers-reduced-transparency:reduce)]:bg-card [@media(prefers-reduced-transparency:reduce)]:backdrop-blur-none border-t border-border/20 rounded-t-[28px] pt-2.5 pb-2 safe-bottom max-h-[85vh] overflow-y-auto overscroll-contain">
              <div className="flex justify-center pb-2">
                <span className="h-1 w-9 rounded-full bg-border" />
              </div>
              {groups.map((g, gi) => (
                <div key={gi} role="group" className={gi > 0 ? "mt-1 pt-1 border-t border-border/40" : ""}>
                  {g.map((item) => (
                    <button key={item.label}
                      onClick={() => handle(item.action, item.destructive, item.kind)}
                      className={`w-full flex items-center gap-3 px-5 py-3 text-sm transition-colors active:bg-muted/60 min-h-11 text-left ${
                        item.destructive ? "text-destructive" : "text-foreground"
                      }`}>
                      <item.icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
                      <span className="min-w-0 break-words">{item.label}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};

export default MessageContextMenu;

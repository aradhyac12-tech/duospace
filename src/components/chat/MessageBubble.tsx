import { motion, useMotionValue, useTransform } from "framer-motion";
import {
  Reply, Pin, Pencil, ImageIcon, FileText,
} from "lucide-react";
import { useRef, useMemo } from "react";
import { useLongPress } from "@/hooks/useLongPress";
import { hapticLight, hapticSwipe } from "@/lib/haptics";
import MessageStatus from "@/components/chat/MessageStatus";
import MessageReactions from "@/components/chat/MessageReactions";
import QuotedMessage from "@/components/chat/QuotedMessage";
import DisappearRing from "@/components/chat/DisappearRing";
import VoiceMessagePlayer from "@/components/chat/VoiceMessagePlayer";
import UploadProgressRing from "@/components/chat/UploadProgressRing";
import type { DecryptedMessage } from "@/types/chat";

// ─── MessageBubble ──────────────────────────────────────────────────────────
// Pure presentational component — receives fully-decrypted message data,
// group/highlight flags, reactions, and callbacks as props. Owns no chat
// state, no realtime, no persistence — extracted unchanged from
// pages/Chat.tsx (Phase 3 UI/state decomposition, "Message bubble system"
// layer). All swipe-to-reply / long-press / disappear-ring visuals are
// preserved exactly as they were.
const MessageBubble = ({
  msg, isMine, isDisappearing, isHighlighted, isActiveResult,
  repliedMsg, partnerName, userId,
  isFirstInGroup, isLastInGroup, isSenderChange, partnerAvatar,
  onReply, onLongPress, onPhotoView, formatTime, onRetry,
  allReactions, mediaVisible, isReactingTo, onReactionPickerClose,
}: {
  msg: DecryptedMessage; isMine: boolean; isDisappearing: boolean;
  isHighlighted: boolean; isActiveResult: boolean;
  repliedMsg: DecryptedMessage | null; partnerName: string; userId: string;
  isFirstInGroup: boolean; isLastInGroup: boolean;
  /** True when this is the first bubble of a group AND the previous
   *  timeline item was a different sender (or not a message at all, e.g.
   *  a call event) — i.e. an actual conversational turn change, not just
   *  the same sender re-grouping after the 4-minute gap. Optional/falsy-
   *  safe so any other caller of this component keeps working unchanged. */
  isSenderChange?: boolean; partnerAvatar: string | null;
  onReply: () => void; onLongPress: () => void;
  onPhotoView: (url: string, id: string) => void; formatTime: (iso: string) => string;
  /** Only relevant for a message with _sendStatus === "failed" — retries
   *  the original send with the same content. Optional so this component
   *  keeps working if a caller doesn't wire optimistic sending at all. */
  onRetry?: () => void;
  allReactions?: { id: string; message_id: string; user_id: string; emoji: string; created_at: string }[]; mediaVisible?: boolean;
  isReactingTo?: boolean; onReactionPickerClose?: () => void;
}) => {
  const lph = useLongPress(onLongPress, 500);
  // Swipe-to-reply: track drag offset as a motion value (not React state) so
  // the icon reveal is driven by the compositor, not a re-render per frame.
  const dragX = useMotionValue(0);
  const REPLY_THRESHOLD = 44;
  const replyIconOpacity = useTransform(dragX, [0, REPLY_THRESHOLD], [0, 1]);
  const replyIconScale = useTransform(dragX, [0, REPLY_THRESHOLD], [0.6, 1]);
  const swipeFiredRef = useRef(false);

  // Optimistic-send UI: a media message still uploading shows its local
  // blob preview (visible/playable immediately) with file_url as the
  // fallback once the real one lands; a text message has no separate
  // preview since its content is already known at send time. See
  // types/chat.ts's DecryptedMessage._localPreviewUrl doc comment.
  const mediaSrc = msg.file_url ?? msg._localPreviewUrl ?? null;
  const isSending = msg._sendStatus === "sending";
  const isFailed = msg._sendStatus === "failed";

  // POLISH (premium disappearing-message countdown): totalMs/remainingMs
  // for the ring, and a CSS animation-delay for the "about to vanish"
  // glow — both computed once from the message's own created_at/
  // disappear_at rather than a ticking React state, so a chat full of
  // disappearing messages never re-renders once a second per bubble.
  // Memoized on the message's own identity (not on the current render's
  // Date.now()) — otherwise an unrelated re-render (a reaction landing, the
  // typing indicator flipping, etc.) would recompute a new animation-delay
  // each time and restart the CSS pulse/ring from scratch instead of
  // letting it run continuously toward the real expiry instant.
  const disappearTiming = useMemo(() => {
    if (!isDisappearing || !msg.disappear_at) return null;
    const total = new Date(msg.disappear_at).getTime() - new Date(msg.created_at).getTime();
    const remaining = new Date(msg.disappear_at).getTime() - Date.now();
    return { totalMs: Math.max(1, total), remainingMs: Math.max(0, remaining) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDisappearing, msg.disappear_at, msg.created_at]);
  const IMMINENT_WINDOW_MS = 2500;

  return (
    <motion.div id={`msg-${msg.id}`}
      layout="position"
      initial={{ opacity: 0, y: 4, scale: 1 }} animate={{ opacity: isDisappearing ? 0.75 : 1, y: 0, scale: 1 }}
      exit={isDisappearing ? {
        // POLISH: disappearing messages get their own distinct "evaporate"
        // exit — a slower, softer upward dissolve — instead of reusing the
        // sharp pop used for a manual delete, so the two read as visually
        // different actions (one intentional and instant, one gentle and
        // expected).
        opacity: 0, scale: 0.88, y: -10, filter: "blur(8px)",
        transition: { duration: 0.55, ease: [0.4, 0, 0.2, 1] },
      } : {
        opacity: 0, scale: 0.94, filter: "blur(3px)",
        transition: { type: "spring", stiffness: 260, damping: 30 },
      }}
      transition={{ duration: 0.15, ease: "easeOut", layout: { duration: 0.3, ease: "easeOut" } }}
      className={`flex ${isMine?"justify-end":"justify-start"} group ${
        isFirstInGroup ? (isSenderChange ? "pt-3.5" : "pt-2") : "pt-[1px]"
      } ${
        isActiveResult  ? "ring-2 ring-primary rounded-2xl"
        : isHighlighted ? "ring-1 ring-primary/40 rounded-2xl"
        : ""
      }`}>
      <motion.div
        className="flex items-end gap-1.5 max-w-[80%] relative"
        style={{ x: dragX }}
        drag="x"
        dragConstraints={{ left: 0, right: REPLY_THRESHOLD + 16 }}
        dragElastic={0.15}
        dragSnapToOrigin
        onDrag={(_, info) => {
          if (!swipeFiredRef.current && info.offset.x > REPLY_THRESHOLD) {
            swipeFiredRef.current = true;
            hapticSwipe();
          }
        }}
        onDragEnd={(_, info) => {
          if (info.offset.x > REPLY_THRESHOLD) onReply();
          swipeFiredRef.current = false;
        }}
        {...lph}
      >
        {/* Reply-icon reveal — purely visual, follows the same drag offset */}
        <motion.div
          aria-hidden="true"
          style={{ opacity: replyIconOpacity, scale: replyIconScale }}
          className="absolute -left-8 top-1/2 -translate-y-1/2 h-6 w-6 rounded-full bg-muted flex items-center justify-center pointer-events-none"
        >
          <Reply className="h-3 w-3 text-muted-foreground" />
        </motion.div>
        {isMine && (
          <button onClick={() => { hapticLight(); onReply(); }} aria-label="Reply to this message"
            className="h-6 w-6 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all text-muted-foreground hover:text-foreground mb-1">
            <Reply className="h-3 w-3" aria-hidden="true" />
          </button>
        )}
        {/* Partner avatar — shown only on the first bubble of a consecutive
            group; a same-width spacer keeps later bubbles in the group
            aligned instead of the avatar repeating on every message. */}
        {!isMine && (
          isFirstInGroup ? (
            <div className="h-6 w-6 rounded-full overflow-hidden shrink-0 mb-0.5 bg-muted flex items-center justify-center text-[10px] font-medium">
              {partnerAvatar ? <img src={partnerAvatar} alt="" className="h-full w-full object-cover" /> : (partnerName?.[0]?.toUpperCase() || "?")}
            </div>
          ) : <div className="w-6 shrink-0" />
        )}
        {/* Phase 2 (visual correction): partner bubble tone lightened from
            a bordered/blurred "card" (bg-card/70 + backdrop-blur + border)
            to a plain tonal surface — "don't put every message in a card,"
            "don't add shadows to every message." Photo messages bleed to
            the card's own edges below (negative margins around the <img>)
            instead of sitting inset with padding on all sides, so media
            visually dominates rather than reading as ordinary bubble
            content; captions/replies/reactions keep the normal padding. */}
        <div className={`relative rounded-2xl px-3 py-2 select-none ${
          isMine
            ? `bg-primary text-primary-foreground ${isLastInGroup ? "rounded-br-md" : "rounded-br-2xl"}`
            : `bg-[hsl(var(--surface-2))] ${isLastInGroup ? "rounded-bl-md" : "rounded-bl-2xl"}`
        } ${isDisappearing ? "ring-1 ring-primary/20" : ""} ${isFailed ? "ring-1 ring-destructive/50" : ""}`}
          onClick={isFailed ? (e) => { e.stopPropagation(); onRetry?.(); } : undefined}
        >
          {/* POLISH: a soft glow that breathes on in just the last ~2.5s
              before this specific message vanishes — pure CSS, timed via
              animation-delay from this message's own remaining time, no
              JS ticking involved. Builds a little anticipation right
              before the message actually disappears instead of it just
              vanishing with no warning. */}
          {disappearTiming && (
            <div
              aria-hidden="true"
              className="absolute -inset-px rounded-2xl pointer-events-none"
              style={{
                animation: "disappear-imminent 2.5s ease-in-out both",
                animationDelay: `${Math.max(0, disappearTiming.remainingMs - IMMINENT_WINDOW_MS)}ms`,
                boxShadow: "0 0 0 1.5px hsl(var(--primary)), 0 0 14px 2px hsl(var(--primary) / 0.4)",
              }}
            />
          )}
          {repliedMsg && (
            <QuotedMessage content={repliedMsg.decryptedContent||"Message"}
              senderName={repliedMsg.sender_id===userId?"You":partnerName} isMine={isMine} />
          )}
          {msg.is_pinned && (
            <div className="flex items-center gap-1 mb-1 opacity-50">
              <Pin className="h-2.5 w-2.5" /><span className="text-[9px]">Pinned</span>
            </div>
          )}
          {/* Voice */}
          {msg.message_type==="voice" && mediaSrc && (
            <div className="relative rounded-xl overflow-hidden">
              <VoiceMessagePlayer src={mediaSrc} isMine={isMine} />
              {isSending && <UploadProgressRing progress={msg._uploadProgress} size={28} />}
            </div>
          )}
          {/* Nudge */}
          {msg.message_type==="nudge" && (
            <motion.div animate={{ scale:[1,1.3,0.9,1.1,1] }} transition={{ duration:0.5 }}
              className="text-2xl select-none">❤️</motion.div>
          )}
          {/* Love letter */}
          {msg.message_type==="letter" && msg.decryptedContent && (
            <div className={`rounded-xl px-3 py-2.5 mb-1 ${isMine?"bg-primary-foreground/15":"bg-primary/5 border border-primary/15"}`}>
              <span className="text-base mr-1.5">💌</span>
              {msg.decryptedContent.split("\n").map((line,i) => (
                <span key={i} className={`block ${i===0?"font-semibold text-[13px]":"text-[13px] leading-relaxed mt-1 opacity-90"}`}>
                  {line.replace(/^\*\*|\*\*$/g,"")}
                </span>
              ))}
            </div>
          )}
          {/* Image — bleeds past the card's own px-3 py-2 padding via
              negative margins so it reaches the bubble's rounded edges
              (dominating, not "content inside a card"). -mt-2 only when
              there's nothing above it (no reply/pin) so it doesn't overlap
              those; -mx-3 always since the image has no horizontal
              neighbor. Kept mb-1 so caption text below still gets breathing
              room, and rounding only follows the corners actually exposed
              (top corners round only when it's the first thing in the
              bubble) so it doesn't fight the bubble's own corner radius. */}
          {msg.message_type==="image" && mediaSrc && (
            mediaVisible!==false ? (
              <div className={`relative -mx-3 mb-1 ${
                  (!repliedMsg && !msg.is_pinned) ? "-mt-2 rounded-t-2xl" : ""
                } ${(!msg.decryptedContent) ? "rounded-b-2xl" : ""} overflow-hidden`}>
                {/* Phase 2.5, section 13: layoutId shared with PhotoViewer's
                    fullscreen <motion.img> (same `photo-${msg.id}` key) —
                    Framer Motion animates the actual rect between this
                    thumbnail and the fullscreen image instead of the old
                    independent-fade behavior. */}
                <motion.img layoutId={`photo-${msg.id}`}
                  onClick={() => { hapticLight(); onPhotoView(mediaSrc, msg.id); }} src={mediaSrc} alt="shared"
                  loading="lazy" decoding="async"
                  className="max-h-64 object-cover w-full cursor-pointer active:scale-[0.99] transition-transform" />
                {isSending && <UploadProgressRing progress={msg._uploadProgress} />}
              </div>
            ) : (
              <button onClick={() => { hapticLight(); onPhotoView(mediaSrc, msg.id); }}
                className={`flex items-center gap-2 mb-1 rounded-xl px-3 py-2.5 w-full ${isMine?"bg-primary-foreground/15":"bg-muted/50"}`}>
                <ImageIcon className="h-4 w-4 shrink-0 opacity-50" />
                <span className="text-xs opacity-60">Photo — tap to view</span>
              </button>
            )
          )}
          {/* File */}
          {msg.message_type==="file" && msg.file_name && (
            <a href={isSending ? undefined : (mediaSrc||"#")} target="_blank" rel="noopener"
              onClick={isSending ? (e) => e.preventDefault() : undefined}
              className={`relative flex items-center gap-2 mb-1 rounded-lg px-2 py-1.5 overflow-hidden ${isMine?"bg-primary-foreground/15":"bg-muted/50"}`}>
              <FileText className="h-3.5 w-3.5 shrink-0 opacity-50" />
              <span className="text-xs truncate">{msg.file_name}</span>
              {isSending && <UploadProgressRing progress={msg._uploadProgress} size={22} />}
            </a>
          )}
          {/* Text */}
          {msg.message_type!=="voice" && msg.message_type!=="letter" && msg.message_type!=="nudge" && msg.decryptedContent && (
            <p className="text-[14px] leading-relaxed whitespace-pre-wrap">{msg.decryptedContent}</p>
          )}
          {/* Phase 1 (contextual metadata): a plain time+read-receipt row on
              every single bubble in a consecutive group repeats the same
              information — the group already reads top-to-bottom in order,
              and read state logically cascades ("read up to here" implies
              everything above it was too). Only the LAST bubble in a group
              shows the full row now. Functional signals that are specific
              to THIS message rather than the group — the disappearing-
              message countdown ring and the "edited" mark — always render
              regardless of grouping, since those aren't redundant with a
              neighboring bubble's metadata; hiding either would be a real
              information loss, not a decluttering. No data changes here,
              only what's shown: formatTime/is_read/disappear_at are all
              still computed exactly as before. */}
          {(isLastInGroup || isDisappearing || msg.edited_at || msg._sendStatus) && (
            <div className={`flex items-center gap-1 mt-0.5 ${isMine?"justify-end":""}`}>
              {isDisappearing && disappearTiming && (
                <DisappearRing
                  totalMs={disappearTiming.totalMs}
                  remainingMs={disappearTiming.remainingMs}
                  className={isMine ? "text-primary-foreground/70" : "text-muted-foreground/60"}
                />
              )}
              {msg.edited_at && <Pencil className="h-2 w-2 opacity-30" />}
              <span className={`text-[10px] font-mono ${isMine?"text-primary-foreground/70":"text-muted-foreground/60"}`}>
                {formatTime(msg.created_at)}
              </span>
              {isMine && <MessageStatus isRead={msg.is_read} isMine={isMine} sendStatus={msg._sendStatus} onRetry={onRetry} />}
            </div>
          )}
          <MessageReactions messageId={msg.id} userId={userId} isMine={isMine} allReactions={allReactions}
            pickerOpen={isReactingTo} onPickerClose={onReactionPickerClose} />
        </div>
        {!isMine && (
          <button onClick={() => { hapticLight(); onReply(); }} aria-label="Reply to this message"
            className="h-6 w-6 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all text-muted-foreground hover:text-foreground mb-1">
            <Reply className="h-3 w-3" aria-hidden="true" />
          </button>
        )}
      </motion.div>
    </motion.div>
  );
};

export default MessageBubble;

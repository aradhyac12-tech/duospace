import { motion, AnimatePresence } from "framer-motion";
import type { RefObject, Dispatch, SetStateAction } from "react";
import { Phone, PhoneMissed, Video, FileText, Play } from "lucide-react";
import CallEvent from "@/components/chat/CallEvent";
import MessageBubble from "@/components/chat/MessageBubble";
import TypingIndicator from "@/components/chat/TypingIndicator";
import { hapticTick, hapticLight } from "@/lib/haptics";
import type { DecryptedMessage, ImportedMessage, TimelineItem } from "@/types/chat";

// ─── MessageTimeline ─────────────────────────────────────────────────────────
// Pure presentational component covering the scrollable message log: the
// "load older" control, loading/error states, date-grouped sections
// ("Message timeline" + "Date/unread separators" layers), the empty state,
// and the typing indicator. Owns no data-fetching/pagination/realtime logic
// itself — messagesContainerRef and messagesEndRef are created in Chat.tsx
// and passed through so the existing scroll-position/auto-scroll effects
// there keep working unmodified. Extracted unchanged from pages/Chat.tsx
// (Phase 3 UI/state decomposition, continuation pass).

interface MessageTimelineProps {
  messagesContainerRef: RefObject<HTMLDivElement>;
  messagesEndRef: RefObject<HTMLDivElement>;
  hasMoreMessages: boolean;
  loadingMore: boolean;
  loadMoreMessages: () => void;
  messagesLoading: boolean;
  messagesError: string | null;
  fetchMessages: () => void;
  groupedTimeline: { date: string; items: TimelineItem[] }[];
  userId: string | undefined;
  messages: DecryptedMessage[];
  searchResults: string[];
  searchIndex: number;
  partnerName: string;
  partnerAvatar: string | null;
  partnerId: string | null;
  setReplyTo: Dispatch<SetStateAction<DecryptedMessage | null>>;
  inputRef: RefObject<HTMLInputElement>;
  setContextMenuMsg: Dispatch<SetStateAction<DecryptedMessage | null>>;
  setViewingPhoto: Dispatch<SetStateAction<string | null>>;
  formatTime: (iso: string) => string;
  allReactions?: { id: string; message_id: string; user_id: string; emoji: string; created_at: string }[];
  mediaVisible: boolean;
  reactingMsgId: string | null;
  setReactingMsgId: Dispatch<SetStateAction<string | null>>;
  partnerTyping: boolean;
}

const MessageTimeline = ({
  messagesContainerRef, messagesEndRef,
  hasMoreMessages, loadingMore, loadMoreMessages,
  messagesLoading, messagesError, fetchMessages,
  groupedTimeline, userId, messages, searchResults, searchIndex,
  partnerName, partnerAvatar, partnerId,
  setReplyTo, inputRef, setContextMenuMsg, setViewingPhoto,
  formatTime, allReactions, mediaVisible, reactingMsgId, setReactingMsgId,
  partnerTyping,
}: MessageTimelineProps) => (
  <div ref={messagesContainerRef}
    role="log"
    aria-live="polite"
    aria-relevant="additions"
    aria-label="Conversation messages"
    className="flex-1 overflow-y-auto px-3 py-3 min-h-0">
    {hasMoreMessages && (
      <div className="flex justify-center mb-3">
        <button onClick={() => { hapticTick(); loadMoreMessages(); }} disabled={loadingMore}
          className="text-[11px] text-muted-foreground bg-muted/50 px-4 py-1.5 rounded-full active:scale-95 transition-transform disabled:opacity-50">
          {loadingMore?"Loading…":"Load older messages"}
        </button>
      </div>
    )}
    {messagesLoading && <div className="flex justify-center my-8"><p className="text-xs text-muted-foreground animate-pulse">Loading messages…</p></div>}
    {messagesError && !messagesLoading && (
      <div className="flex flex-col items-center gap-2 my-8">
        <p className="text-xs text-muted-foreground text-center">{messagesError}</p>
        <button onClick={() => { hapticLight(); fetchMessages(); }} className="text-[11px] text-primary underline">Retry</button>
      </div>
    )}
    {groupedTimeline.map(group => (
      <div key={group.date}>
        <div className="flex justify-center my-3">
          <span className="text-[10px] text-muted-foreground bg-muted/50 backdrop-blur-sm px-3 py-1 rounded-full">{group.date}</span>
        </div>
        <div className="space-y-0.5">
          <AnimatePresence initial={false}>
          {group.items.map((item, idx) => {
            if (item.type==="call") {
              const c = item.data;
              return <CallEvent key={`call-${c.id}`} callType={c.call_type} status={c.status} direction={c.call_direction} durationSeconds={c.duration_seconds} createdAt={c.created_at} isMine={c.caller_id===userId} />;
            }
            // WA-01 FIX: render imported WhatsApp messages as distinct read-only bubbles
            if (item.type==="imported") {
              const imp = item.data as ImportedMessage;
              const impTime = new Date(imp.original_timestamp).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });
              // WA-08 FIX: whoever imported the chat tags each row with is_self
              // (set at import time via a sender picker) so we can show "You" /
              // the partner's real name instead of the raw WhatsApp export name
              // (often just a phone number for whichever contact wasn't saved).
              const label = imp.is_self ? "You" : (partnerName || imp.sender_name);
              // Imported call log entries (WhatsApp's only source of call
              // history — it isn't otherwise exportable) get a compact
              // CallEvent-style row instead of a text bubble.
              if (imp.file_type === "call") {
                const missed = /^missed/i.test(imp.content || "");
                const isVideo = /video/i.test(imp.content || "");
                return (
                  <div key={`imp-${imp.id}`} className="flex justify-center px-3 py-1">
                    <div className={`flex items-center gap-1.5 text-[11px] px-3 py-1 rounded-full bg-muted/40 border border-border/40 ${missed ? "text-destructive" : "text-muted-foreground"}`}>
                      {missed ? <PhoneMissed className="h-3 w-3" /> : isVideo ? <Video className="h-3 w-3" /> : <Phone className="h-3 w-3" />}
                      <span>{imp.content}</span>
                      <span className="text-muted-foreground/60">· {impTime}</span>
                    </div>
                  </div>
                );
              }
              const isMedia = imp.file_url && (imp.file_type==="image"||imp.file_type==="video"||imp.file_type==="audio"||imp.file_type==="document");
              return (
                <div key={`imp-${imp.id}`} className={`flex px-3 py-0.5 ${imp.is_self ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[75%] bg-muted/40 border border-border/40 rounded-2xl px-3 py-2 space-y-1 ${imp.is_self ? "rounded-tr-sm" : "rounded-tl-sm"}`}>
                    <p className="text-[10px] font-semibold text-primary/70">{label}</p>
                    {isMedia && imp.file_type==="image" && (
                      <button onClick={() => setViewingPhoto(imp.file_url)} className="block">
                        <img src={imp.file_url!} alt="" className="rounded-xl max-h-52 max-w-full object-cover" />
                      </button>
                    )}
                    {isMedia && imp.file_type==="video" && (
                      <video src={imp.file_url!} controls className="rounded-xl max-h-52 max-w-full" />
                    )}
                    {isMedia && imp.file_type==="audio" && (
                      <div className="flex items-center gap-2 bg-background/40 rounded-full px-3 py-1.5">
                        <Play className="h-3.5 w-3.5 shrink-0" />
                        <audio src={imp.file_url!} controls className="h-8 max-w-[180px]" />
                      </div>
                    )}
                    {isMedia && imp.file_type==="document" && (
                      <a href={imp.file_url!} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-xs text-primary underline">
                        <FileText className="h-3.5 w-3.5 shrink-0" /> Open file
                      </a>
                    )}
                    {(!isMedia || imp.file_type==="text") && (
                      <p className="text-sm text-foreground/80 whitespace-pre-wrap break-words">{imp.content}</p>
                    )}
                    <div className="flex items-center gap-1 justify-end">
                      <span className="text-[9px] text-muted-foreground">{impTime}</span>
                      <span className="text-[9px] text-muted-foreground/50 italic">WhatsApp</span>
                    </div>
                  </div>
                </div>
              );
            }
            const msg = item.data;
            const repliedMsg = msg.reply_to_id ? messages.find(m=>m.id===msg.reply_to_id)??null : null;
            const prevItem = group.items[idx-1];
            const nextItem = group.items[idx+1];
            const prevMsg = prevItem?.type==="message" ? prevItem.data : null;
            const nextMsg = nextItem?.type==="message" ? nextItem.data : null;
            const GROUP_GAP_MS = 4*60*1000; // messages within 4 min of the same sender are visually grouped
            const isFirstInGroup = !prevMsg || prevMsg.sender_id!==msg.sender_id
              || (new Date(msg.created_at).getTime() - new Date(prevMsg.created_at).getTime()) > GROUP_GAP_MS;
            const isLastInGroup = !nextMsg || nextMsg.sender_id!==msg.sender_id
              || (new Date(nextMsg.created_at).getTime() - new Date(msg.created_at).getTime()) > GROUP_GAP_MS;
            return (
              <MessageBubble key={msg.id} msg={msg} isMine={msg.sender_id===userId}
                isDisappearing={!!msg.disappear_at&&msg.disappear_at!=="pending"}
                isHighlighted={searchResults.includes(msg.id)} isActiveResult={searchResults[searchIndex]===msg.id}
                repliedMsg={repliedMsg} partnerName={partnerName} userId={userId||""}
                isFirstInGroup={isFirstInGroup} isLastInGroup={isLastInGroup} partnerAvatar={partnerAvatar}
                onReply={() => { setReplyTo(msg); inputRef.current?.focus(); }}
                onLongPress={() => setContextMenuMsg(msg)}
                onPhotoView={url=>setViewingPhoto(url)}
                formatTime={formatTime} allReactions={allReactions} mediaVisible={mediaVisible}
                isReactingTo={reactingMsgId===msg.id} onReactionPickerClose={() => setReactingMsgId(null)}
              />
            );
          })}
          </AnimatePresence>
        </div>
      </div>
    ))}
    {/* FIX: this used to check messages.length===0 only, so a conversation
        that had zero *live* messages but did have call history or imported
        WhatsApp content (both rendered from groupedTimeline, not from
        `messages`) still showed "Start your conversation" layered right
        above that real content. Check the same data actually being
        rendered above instead of a narrower proxy for it. */}
    {!messagesLoading && !messagesError && groupedTimeline.length===0 && (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <div className="h-14 w-14 rounded-full bg-muted flex items-center justify-center"><span className="text-xl">💬</span></div>
        <p className="text-sm text-muted-foreground text-center max-w-[200px]">
          {partnerId?"Start your conversation":"Link with your partner in settings"}
        </p>
      </div>
    )}
    <AnimatePresence>{partnerTyping && <TypingIndicator />}</AnimatePresence>
    <div ref={messagesEndRef} />
  </div>
);

export default MessageTimeline;

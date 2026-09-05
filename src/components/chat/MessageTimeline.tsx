import { motion, AnimatePresence, LayoutGroup } from "framer-motion";
import type { RefObject, Dispatch, SetStateAction } from "react";
import { useMemo } from "react";
import { Phone, PhoneMissed, Video, FileText, Play } from "lucide-react";
import CallEvent from "@/components/chat/CallEvent";
import MessageBubble from "@/components/chat/MessageBubble";
import SurpriseMessage from "@/components/chat/SurpriseMessage";
import TypingIndicator from "@/components/chat/TypingIndicator";
import { hapticTick, hapticLight } from "@/lib/haptics";
import type { EngineSurprise } from "@/lib/surpriseEngine";
import type { SurpriseStage } from "@/lib/surpriseLifecycle";
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
  inputRef: RefObject<HTMLTextAreaElement>;
  setContextMenuMsg: Dispatch<SetStateAction<DecryptedMessage | null>>;
  setViewingPhoto: Dispatch<SetStateAction<{ url: string; id: string } | null>>;
  formatTime: (iso: string) => string;
  allReactions?: { id: string; message_id: string; user_id: string; emoji: string; created_at: string }[];
  mediaVisible: boolean;
  reactingMsgId: string | null;
  setReactingMsgId: Dispatch<SetStateAction<string | null>>;
  partnerTyping: boolean;
  /** Retries a failed optimistic send (see types/chat.ts's
   *  DecryptedMessage._sendStatus). Optional so this stays backward
   *  compatible with any other caller that doesn't wire optimistic
   *  sending. */
  onRetryMessage?: (msg: DecryptedMessage) => void;
  /** Surprise 2.0 phase 1: per-surprise lifecycle stage (see
   *  lib/surpriseLifecycle.ts) and the tap handler that opens the existing
   *  expanded overlay — both come from the single useChatSurprise()
   *  instance owned by Chat.tsx, threaded down here so a SurpriseMessage
   *  row can render its status pips and be interactive. */
  surpriseStageById?: Record<string, SurpriseStage>;
  onOpenSurprise?: (s: EngineSurprise) => void;
  /** Live px height of the unified bottom surface (composer + nav shell),
   *  applied as extra bottom padding so the final message sits comfortably
   *  clear of it — see BottomSurfaceContext.tsx. Replaces the old in-flow
   *  layout where the composer literally displaced this container; now
   *  that the composer is portaled into a fixed shell, this container
   *  needs to reserve the space itself (redesign brief §2/§11: measured/
   *  dynamic inset, not a magic number). Defaults to 0 for any other
   *  caller. */
  bottomInset?: number;
}

const MessageTimeline = ({
  messagesContainerRef, messagesEndRef,
  hasMoreMessages, loadingMore, loadMoreMessages,
  messagesLoading, messagesError, fetchMessages,
  groupedTimeline, userId, messages, searchResults, searchIndex,
  partnerName, partnerAvatar, partnerId,
  setReplyTo, inputRef, setContextMenuMsg, setViewingPhoto,
  formatTime, allReactions, mediaVisible, reactingMsgId, setReactingMsgId,
  partnerTyping, onRetryMessage, bottomInset = 0,
  surpriseStageById, onOpenSurprise,
}: MessageTimelineProps) => {
  // O(1) reply lookups instead of messages.find() per rendered message
  // (was O(n) per reply, O(n·r) across the render pass for long threads
  // with many replies). Rebuilt only when the messages array itself
  // changes, not on every render.
  const messagesById = useMemo(() => {
    const map = new Map<string, DecryptedMessage>();
    for (const m of messages) map.set(m.id, m);
    return map;
  }, [messages]);

  return (
  <div ref={messagesContainerRef}
    role="log"
    aria-live="polite"
    aria-relevant="additions"
    aria-label="Conversation messages"
    // Scroll-edge fade: research into how floating glass bars are meant to
    // work (Apple's own current guidance on this exact pattern — a
    // translucent bar floating over scrollable content) turned up the
    // actual mechanism that makes it read as intentional rather than as
    // content randomly disappearing behind a bar: the content fades out
    // PROGRESSIVELY as it nears the bar's edge, rather than being hard-
    // clipped by it. This mask does that — fully opaque for the vast
    // majority of the scroll area, fading to transparent only over the
    // final stretch nearest the composer/dock. Pure CSS on the container's
    // own edge (not an extra overlay element), so it can't intercept
    // scroll/touch input the way a positioned div sitting on top would.
    // -webkit- prefix required: this renders inside a Capacitor iOS
    // WebView (Safari engine), which doesn't accept the unprefixed
    // property alone.
    // Scroll-edge fade: research into how floating glass bars are meant to
    // work (Apple's own current guidance on this exact pattern — a
    // translucent bar floating over scrollable content) turned up the
    // actual mechanism that makes it read as intentional rather than as
    // content randomly disappearing behind a bar: the content fades out
    // PROGRESSIVELY as it nears the bar's edge, rather than being hard-
    // clipped by it. Kept deliberately short (24px) and partial (fades to
    // 55% opacity, never fully transparent) rather than the fuller version
    // Apple uses for a persistent tab bar sitting over a passive content
    // list — in a chat, the message right above the composer is usually
    // the one just sent or just received, i.e. the one thing legibility
    // matters most for right then. This is closer to Apple's own "soft
    // edge effect (a subtle blur)" characterization than the fuller fade.
    // Pure CSS on the container's own edge (not an extra overlay element),
    // so it can't intercept scroll/touch input the way a positioned div
    // sitting on top would. -webkit- prefix required: this renders inside
    // a Capacitor iOS WebView (Safari engine), which doesn't accept the
    // unprefixed property alone.
    style={{
      WebkitMaskImage: "linear-gradient(to bottom, black calc(100% - 24px), rgb(0 0 0 / 0.55) 100%)",
      maskImage: "linear-gradient(to bottom, black calc(100% - 24px), rgb(0 0 0 / 0.55) 100%)",
      paddingBottom: `calc(0.75rem + ${bottomInset}px)`,
    }}
    // FIX (flicker on fast/repeated scroll): unlike Calls.tsx's list (which
    // already has `overscroll-contain`), this container had no
    // overscroll-behavior at all. Once a fast scroll ran out of content to
    // scroll past the top/bottom edge, the leftover gesture momentum
    // chained straight through to the document — bouncing the WHOLE page
    // (header, wallpaper, composer, dock included) against the raw page
    // background for a frame or two before snapping back, which is exactly
    // the strobing/blank-flash effect visible in the recording. AppLayout's
    // own `.no-overscroll` (FIX AUDIT #13) only stops that chain from its
    // own root div outward — it can't stop a chain that starts one level
    // deeper, inside this list. `overscroll-contain` (not `-none`) keeps
    // this list's own small rubber-band feedback at its edges — which is
    // expected/native-feeling — it just stops that motion from being
    // handed up to the page.
    className="flex-1 overflow-y-auto overscroll-contain px-3 py-3 min-h-0">
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
          {/* Perf: scope each date-group's layout="position" FLIP
              measurements to that group alone (instead of the whole
              mounted timeline, Framer Motion's default LayoutGroup scope)
              so a reflow in one day's messages (new message, reaction,
              "load older") doesn't re-measure every bubble in every other
              day too. See PERFORMANCE_AUDIT.md finding #2. */}
          <LayoutGroup id={group.date}>
          <AnimatePresence initial={false}>
          {group.items.map((item, idx) => {
            if (item.type==="call") {
              const c = item.data;
              return <CallEvent key={`call-${c.id}`} callType={c.call_type} status={c.status} direction={c.call_direction} durationSeconds={c.duration_seconds} createdAt={c.created_at} isMine={c.caller_id===userId} />;
            }
            if (item.type==="surprise") {
              const s = item.data;
              return (
                <SurpriseMessage key={`surprise-${s.id}`} surprise={s} isMine={s.creator_id===userId}
                  stage={surpriseStageById?.[s.id] ?? "sent"} partnerName={partnerName} partnerAvatar={partnerAvatar}
                  createdAt={s.created_at} formatTime={formatTime}
                  onOpen={() => onOpenSurprise?.(s)} />
              );
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
                      <button onClick={() => setViewingPhoto({ url: imp.file_url!, id: imp.id })} className="block">
                        <img loading="lazy" decoding="async" src={imp.file_url!} alt="" className="rounded-xl max-h-52 max-w-full object-cover" />
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
            const repliedMsg = msg.reply_to_id ? messagesById.get(msg.reply_to_id) ?? null : null;
            const prevItem = group.items[idx-1];
            const nextItem = group.items[idx+1];
            const prevMsg = prevItem?.type==="message" ? prevItem.data : null;
            const nextMsg = nextItem?.type==="message" ? nextItem.data : null;
            const GROUP_GAP_MS = 4*60*1000; // messages within 4 min of the same sender are visually grouped
            const isFirstInGroup = !prevMsg || prevMsg.sender_id!==msg.sender_id
              || (new Date(msg.created_at).getTime() - new Date(prevMsg.created_at).getTime()) > GROUP_GAP_MS;
            const isLastInGroup = !nextMsg || nextMsg.sender_id!==msg.sender_id
              || (new Date(nextMsg.created_at).getTime() - new Date(msg.created_at).getTime()) > GROUP_GAP_MS;
            // Phase 2.5, section 11 (message rhythm): a genuine turn change
            // (the other person actually started talking, or a non-message
            // item like a call event sits between) reads better with more
            // air than a same-sender regroup that only split because of the
            // 4-minute gap — those two cases previously got identical pt-2
            // spacing in MessageBubble, so a real back-and-forth felt no
            // different from one person sending several bursts in a row.
            // Only affects isFirstInGroup's top spacing; grouping/corner
            // logic itself (unchanged above) still governs isLastInGroup.
            const isSenderChange = !prevItem || prevItem.type!=="message" || prevMsg?.sender_id!==msg.sender_id;
            return (
              <MessageBubble key={msg.id} msg={msg} isMine={msg.sender_id===userId}
                isDisappearing={!!msg.disappear_at&&msg.disappear_at!=="pending"&&msg.disappear_at!=="vanish"}
                isVanishing={msg.disappear_at==="vanish"}
                isHighlighted={searchResults.includes(msg.id)} isActiveResult={searchResults[searchIndex]===msg.id}
                repliedMsg={repliedMsg} partnerName={partnerName} userId={userId||""}
                isFirstInGroup={isFirstInGroup} isLastInGroup={isLastInGroup} isSenderChange={isSenderChange} partnerAvatar={partnerAvatar}
                onReply={() => { setReplyTo(msg); inputRef.current?.focus(); }}
                onLongPress={() => setContextMenuMsg(msg)}
                onPhotoView={(url, id) => setViewingPhoto({ url, id })}
                formatTime={formatTime} allReactions={allReactions} mediaVisible={mediaVisible}
                isReactingTo={reactingMsgId===msg.id} onReactionPickerClose={() => setReactingMsgId(null)}
                onRetry={msg._sendStatus === "failed" ? () => onRetryMessage?.(msg) : undefined}
              />
            );
          })}
          </AnimatePresence>
          </LayoutGroup>
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
};

export default MessageTimeline;

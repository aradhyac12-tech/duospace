import { motion, AnimatePresence, LayoutGroup } from "framer-motion";
import type { RefObject, Dispatch, SetStateAction, ReactNode } from "react";
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isOnlineNow, subscribeConnectivity } from "@/lib/connectivity";
import { Phone, PhoneMissed, Video, FileText, Play } from "lucide-react";
import CallEvent from "@/components/chat/CallEvent";
import MessageBubble from "@/components/chat/MessageBubble";
import SurpriseMessage from "@/components/chat/SurpriseMessage";
import TypingIndicator from "@/components/chat/TypingIndicator";
import { hapticTick, hapticLight } from "@/lib/haptics";
import { useVirtualList } from "@/hooks/useVirtualList";
import type { EngineSurprise } from "@/lib/surpriseEngine";
import type { SurpriseStage } from "@/lib/surpriseLifecycle";
import type { DecryptedMessage, ImportedMessage, TimelineItem } from "@/types/chat";
import MessageListSkeleton from "@/components/skeletons/MessageListSkeleton";
import { isVanishValue } from "@/lib/chatConstants";

// ─── MessageTimeline ─────────────────────────────────────────────────────────
// Pure presentational component covering the scrollable message log: the
// "load older" control, loading/error states, date-grouped sections
// ("Message timeline" + "Date/unread separators" layers), the empty state,
// and the typing indicator. Owns no data-fetching/pagination/realtime logic
// itself — messagesContainerRef and messagesEndRef are created in Chat.tsx
// and passed through so the existing scroll-position/auto-scroll effects
// there keep working unmodified. Extracted unchanged from pages/Chat.tsx
// (Phase 3 UI/state decomposition, continuation pass).
//
// PERF (long-conversation virtualization): a large WhatsApp import or a
// couple's long-running history could carry thousands of timeline rows,
// and every one of them used to get a real DOM node + a Framer Motion
// instance whether it was ever scrolled into view or not — the actual
// cause of "it gets slow the longer we've been chatting." Below
// VIRTUAL_ROW_THRESHOLD total rows, this renders through the EXACT same
// nested date-group / AnimatePresence / LayoutGroup path as before —
// untouched, so the vast majority of conversations (which never get
// remotely close to that count) see zero behavior change. Only once a
// conversation's combined message/call/surprise/imported/date-separator
// row count crosses the threshold does it switch to windowed rendering
// (see the flatRows/useVirtualList branch below), which is where the
// actual perf win lives.
const VIRTUAL_ROW_THRESHOLD = 400;

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
  /** Opens LetterReader over a letter's decrypted content — same lift-state
   *  pattern as setViewingPhoto above, just for the envelope reader. */
  setViewingLetter: Dispatch<SetStateAction<{ content: string; isMine: boolean } | null>>;
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

/** Imperative handle so Chat.tsx can ask this list to scroll a specific
 *  message into view without knowing whether the list is currently
 *  virtualized. Below the virtualization threshold every message already
 *  has a real DOM node at all times, so `document.getElementById` +
 *  `scrollIntoView` (Chat.tsx's old inline approach) works unconditionally
 *  and is kept as the direct path here too. Once virtualized, an
 *  off-screen target has no DOM node yet — jumping to it needs the flat
 *  row index (known only inside this component) to compute a scroll
 *  position first, then a short settle-and-refine pass once the row has
 *  actually mounted into the render window. */
export interface MessageTimelineHandle {
  scrollToMessage: (messageId: string, opts?: { block?: ScrollLogicalPosition }) => void;
}

type FlatRow = { key: string; node: ReactNode; isDateSeparator: boolean; messageId?: string };

// CHAT RELIABILITY v2 — root cause of "message sends, disappears, then
// reappears" (reported against this exact build): a just-sent message's
// `msg.id` starts as `pending-<uuid>` (the optimistic bubble) and is
// replaced with the real server-generated id the moment the insert is
// confirmed (see attemptSendText in Chat.tsx). Every render path here
// used `msg.id` directly as the React key (and, in the virtualized path,
// as the `seenRowKeysRef` cache key that drives `skipEnterAnimation`).
// React treats a key change as "this list item was removed, a different
// one was added" — so the optimistic node unmounts (playing its EXIT
// animation under `<AnimatePresence>` in the non-virtualized path) and a
// brand-new node mounts in its place (playing its ENTRANCE animation
// again) — a real fade-out-then-fade-in, not a rendering illusion. The
// virtualized path's own `skipEnterAnimation` mechanism (built for
// exactly this) was defeated the same way: `seen.has(msg.id)` is checked
// against the NEW id, which was never added to `seen` before.
//
// Fix: derive a key that stays constant across that transition instead
// of `msg.id` itself. A message's `client_message_id` (set at insert
// time, echoed back on every fetch — see supabase/migrations/
// 20260910130000_messages_client_message_id_idempotency.sql) is exactly
// that stable value: the optimistic bubble's `pending-<uuid>` id and the
// confirmed row's `client_message_id` share the same `<uuid>`. Messages
// with neither (partner's messages, which never go through a pending
// phase from this client, and legacy rows with no client_message_id)
// simply fall back to their own already-stable `msg.id`.
//
// NOT used for `flatIndexByMessageId` (scroll-to-message lookups) or the
// `msg-${msg.id}` DOM id MessageBubble sets on its own root node — both
// of those are keyed by the real, current `msg.id` on purpose (callers
// like "jump to reply" or "jump to search result" only ever target
// already-confirmed messages, which have a real id from the moment
// they're addressable at all) and are unaffected by this change.
function stableMessageKey(msg: DecryptedMessage): string {
  if (msg.client_message_id) return `msg-${msg.client_message_id}`;
  if (msg.id.startsWith("pending-")) return `msg-${msg.id.slice("pending-".length)}`;
  return msg.id;
}

/** Wraps one row of the virtualized render path: absolutely positions it
 *  at its computed offset and reports its real rendered height back to
 *  useVirtualList via ResizeObserver, so variable-height rows (a voice
 *  message, a long caption, a photo) measure themselves instead of
 *  relying on a single guessed height for everything. Padding (never
 *  margin) supplies the visual gap between rows — margin on a lone
 *  in-flow child can collapse through to this wrapper's own box in ways
 *  that would make the ResizeObserver under-report the space actually
 *  occupied, drifting every offset below it. */
const VirtualRow = ({
  index, start, isDateSeparator, onMeasure, children,
}: {
  index: number; start: number; isDateSeparator: boolean;
  onMeasure: (index: number, height: number) => void;
  children: ReactNode;
}) => {
  const rowRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    onMeasure(index, el.getBoundingClientRect().height);
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height;
      if (h) onMeasure(index, h);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [index, onMeasure]);
  return (
    <div
      ref={rowRef}
      style={{
        position: "absolute", top: start, left: 0, right: 0,
        paddingTop: isDateSeparator ? 12 : 0,
        paddingBottom: isDateSeparator ? 12 : 2,
      }}
    >
      {children}
    </div>
  );
};

const MessageTimeline = forwardRef<MessageTimelineHandle, MessageTimelineProps>(({
  messagesContainerRef, messagesEndRef,
  hasMoreMessages, loadingMore, loadMoreMessages,
  messagesLoading, messagesError, fetchMessages,
  groupedTimeline, userId, messages, searchResults, searchIndex,
  partnerName, partnerAvatar, partnerId,
  setReplyTo, inputRef, setContextMenuMsg, setViewingPhoto, setViewingLetter,
  formatTime, allReactions, mediaVisible, reactingMsgId, setReactingMsgId,
  partnerTyping, onRetryMessage, bottomInset = 0,
  surpriseStageById, onOpenSurprise,
}, ref) => {
  // OFFLINE-CLARITY IMPROVEMENT: an empty timeline used to always say "Start
  // your conversation" — indistinguishable from a genuinely new chat even
  // when the real reason is "you're offline and this conversation was never
  // opened on this device before, so there's nothing cached to show yet".
  // That ambiguity is exactly what read as "stuck"/broken. Track connectivity
  // locally so the empty state can say which one it actually is.
  const [isOffline, setIsOffline] = useState(() => !isOnlineNow());
  useEffect(() => subscribeConnectivity((online) => setIsOffline(!online)), []);

  // O(1) reply lookups instead of messages.find() per rendered message
  // (was O(n) per reply, O(n·r) across the render pass for long threads
  // with many replies). Rebuilt only when the messages array itself
  // changes, not on every render.
  const messagesById = useMemo(() => {
    const map = new Map<string, DecryptedMessage>();
    for (const m of messages) map.set(m.id, m);
    return map;
  }, [messages]);

  const totalRowCount = useMemo(
    () => groupedTimeline.reduce((n, g) => n + g.items.length + 1, 0),
    [groupedTimeline],
  );
  const isVirtualized = totalRowCount >= VIRTUAL_ROW_THRESHOLD;

  // Which rows have already played their own mount-in animation at least
  // once this session — read/written during render (not state) on
  // purpose: it's a one-way "has this happened yet" flag for an
  // animation freebie, not something that should itself trigger a
  // re-render. Only matters once isVirtualized is true (see
  // skipEnterAnimation below); harmless and unused otherwise.
  const seenRowKeysRef = useRef<Set<string>>(new Set());

  // Builds the flat, index-addressable row list the virtualized path
  // renders from — date separators plus every call/surprise/imported/
  // message row, in the same order and with the same per-row grouping
  // logic (isFirstInGroup/isLastInGroup/isSenderChange) the original
  // nested-map path below computes inline. Only actually built when
  // isVirtualized is true; otherwise this is a cheap empty array — the
  // unvirtualized branch below never reads it at all.
  const flatRows: FlatRow[] = useMemo(() => {
    if (!isVirtualized) return [];
    const rows: FlatRow[] = [];
    const GROUP_GAP_MS = 4 * 60 * 1000;
    const seen = seenRowKeysRef.current;
    for (const group of groupedTimeline) {
      rows.push({
        key: `date-${group.date}`,
        isDateSeparator: true,
        node: (
          <div className="flex justify-center">
            <span className="text-[10px] text-muted-foreground bg-muted/50 backdrop-blur-sm px-3 py-1 rounded-full">{group.date}</span>
          </div>
        ),
      });
      group.items.forEach((item, idx) => {
        if (item.type === "call") {
          const c = item.data;
          rows.push({
            key: `call-${c.id}`, isDateSeparator: false,
            node: <CallEvent callType={c.call_type} status={c.status} direction={c.call_direction} durationSeconds={c.duration_seconds} createdAt={c.created_at} isMine={c.caller_id===userId} declinedAt={c.declined_at} />,
          });
          return;
        }
        if (item.type === "surprise") {
          const s = item.data;
          const key = `surprise-${s.id}`;
          const wasSeen = seen.has(key); seen.add(key);
          rows.push({
            key, isDateSeparator: false,
            node: (
              <SurpriseMessage surprise={s} isMine={s.creator_id===userId}
                stage={surpriseStageById?.[s.id] ?? "sent"} partnerName={partnerName} partnerAvatar={partnerAvatar}
                createdAt={s.created_at} formatTime={formatTime}
                onOpen={() => onOpenSurprise?.(s)}
                skipEnterAnimation={wasSeen} />
            ),
          });
          return;
        }
        if (item.type === "imported") {
          const imp = item.data as ImportedMessage;
          const impTime = new Date(imp.original_timestamp).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });
          const label = imp.is_self ? "You" : (partnerName || imp.sender_name);
          if (imp.file_type === "call") {
            const missed = /^missed/i.test(imp.content || "");
            const isVideo = /video/i.test(imp.content || "");
            rows.push({
              key: `imp-${imp.id}`, isDateSeparator: false,
              node: (
                <div className="flex justify-center px-3 py-1">
                  <div className={`flex items-center gap-1.5 text-[11px] px-3 py-1 rounded-full bg-muted/40 border border-border/40 ${missed ? "text-destructive" : "text-muted-foreground"}`}>
                    {missed ? <PhoneMissed className="h-3 w-3" /> : isVideo ? <Video className="h-3 w-3" /> : <Phone className="h-3 w-3" />}
                    <span>{imp.content}</span>
                    <span className="text-muted-foreground/60">· {impTime}</span>
                  </div>
                </div>
              ),
            });
            return;
          }
          const isMedia = imp.file_url && (imp.file_type==="image"||imp.file_type==="video"||imp.file_type==="audio"||imp.file_type==="document");
          rows.push({
            key: `imp-${imp.id}`, isDateSeparator: false,
            node: (
              <div className={`flex px-3 py-0.5 ${imp.is_self ? "justify-end" : "justify-start"}`}>
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
                    <p className="text-sm text-foreground/80 whitespace-pre-wrap break-words" style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}>{imp.content}</p>
                  )}
                  <div className="flex items-center gap-1 justify-end">
                    <span className="text-[9px] text-muted-foreground">{impTime}</span>
                    <span className="text-[9px] text-muted-foreground/50 italic">WhatsApp</span>
                  </div>
                </div>
              </div>
            ),
          });
          return;
        }
        const msg = item.data;
        const rowKey = stableMessageKey(msg);
        const wasSeen = seen.has(rowKey); seen.add(rowKey);
        const repliedMsg = msg.reply_to_id ? messagesById.get(msg.reply_to_id) ?? null : null;
        const prevItem = group.items[idx-1];
        const nextItem = group.items[idx+1];
        const prevMsg = prevItem?.type==="message" ? prevItem.data : null;
        const nextMsg = nextItem?.type==="message" ? nextItem.data : null;
        const isFirstInGroup = !prevMsg || prevMsg.sender_id!==msg.sender_id
          || (new Date(msg.created_at).getTime() - new Date(prevMsg.created_at).getTime()) > GROUP_GAP_MS;
        const isLastInGroup = !nextMsg || nextMsg.sender_id!==msg.sender_id
          || (new Date(nextMsg.created_at).getTime() - new Date(msg.created_at).getTime()) > GROUP_GAP_MS;
        const isSenderChange = !prevItem || prevItem.type!=="message" || prevMsg?.sender_id!==msg.sender_id;
        rows.push({
          key: rowKey, isDateSeparator: false, messageId: msg.id,
          node: (
            <MessageBubble msg={msg} isMine={msg.sender_id===userId}
              isDisappearing={!!msg.disappear_at&&msg.disappear_at!=="pending"&&!isVanishValue(msg.disappear_at)}
              isVanishing={isVanishValue(msg.disappear_at)}
              isHighlighted={searchResults.includes(msg.id)} isActiveResult={searchResults[searchIndex]===msg.id}
              repliedMsg={repliedMsg} partnerName={partnerName} userId={userId||""}
              isFirstInGroup={isFirstInGroup} isLastInGroup={isLastInGroup} isSenderChange={isSenderChange} partnerAvatar={partnerAvatar}
              onReply={() => { setReplyTo(msg); inputRef.current?.focus(); }}
              onLongPress={() => setContextMenuMsg(msg)}
              onPhotoView={(url, id) => setViewingPhoto({ url, id })}
              onLetterOpen={(content) => setViewingLetter({ content, isMine: msg.sender_id===userId })}
              formatTime={formatTime} allReactions={allReactions} mediaVisible={mediaVisible}
              isReactingTo={reactingMsgId===msg.id} onReactionPickerClose={() => setReactingMsgId(null)}
              onRetry={msg._sendStatus === "failed" ? () => onRetryMessage?.(msg) : undefined}
              skipEnterAnimation={wasSeen}
            />
          ),
        });
      });
    }
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVirtualized, groupedTimeline, userId, messagesById, searchResults, searchIndex,
      partnerName, partnerAvatar, formatTime, allReactions, mediaVisible, reactingMsgId,
      surpriseStageById, onOpenSurprise, setReplyTo, inputRef, setContextMenuMsg,
      setViewingPhoto, setViewingLetter, setReactingMsgId, onRetryMessage]);

  // Built from each row's real `messageId` (not `row.key`, which is now a
  // stable-across-optimistic-transition key — see stableMessageKey above
  // — and would no longer match the real id callers pass to
  // scrollToMessage). Non-message rows never set `messageId`.
  const flatIndexByMessageId = useMemo(() => {
    const m = new Map<string, number>();
    flatRows.forEach((row, i) => { if (row.messageId) m.set(row.messageId, i); });
    return m;
  }, [flatRows]);

  const { virtualItems, totalHeight, measureItem, scrollToIndex } = useVirtualList({
    itemCount: flatRows.length,
    estimatedItemHeight: 56,
    overscan: 12,
    containerRef: messagesContainerRef,
  });

  const onMeasure = useCallback((index: number, height: number) => measureItem(index, height), [measureItem]);

  useImperativeHandle(ref, () => ({
    scrollToMessage: (messageId: string, opts) => {
      if (!isVirtualized) {
        document.getElementById(`msg-${messageId}`)?.scrollIntoView({ behavior: "smooth", block: opts?.block ?? "center" });
        return;
      }
      const index = flatIndexByMessageId.get(messageId);
      if (index === undefined) return;
      scrollToIndex(index, "smooth");
      // scrollToIndex lands the row's estimated/measured top at the
      // container's scroll position, which brings it inside the render
      // window (overscan included) — but it still needs a render pass to
      // actually mount before a precise block:"center" adjustment is
      // possible. A short bounded retry (rAF, not a fixed timeout) copes
      // with slower devices without under- or over-waiting.
      let attempts = 0;
      const tryRefine = () => {
        const el = document.getElementById(`msg-${messageId}`);
        if (el) { el.scrollIntoView({ behavior: "smooth", block: opts?.block ?? "center" }); return; }
        if (attempts++ < 15) requestAnimationFrame(tryRefine);
      };
      requestAnimationFrame(tryRefine);
    },
  }), [isVirtualized, flatIndexByMessageId, scrollToIndex]);

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
      // FIX: +6px (~1.5mm) breathing room — the last bubble's own border
      // was sitting right up against/under the composer's top edge with
      // just the base 0.75rem gap.
      paddingBottom: `calc(0.75rem + 6px + ${bottomInset}px)`,
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
    className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-3 py-3 min-h-0">
    {hasMoreMessages && (
      <div className="flex justify-center mb-3">
        <button onClick={() => { hapticTick(); loadMoreMessages(); }} disabled={loadingMore}
          className="text-[11px] text-muted-foreground bg-muted/50 px-4 py-1.5 rounded-full active:scale-95 transition-transform disabled:opacity-50">
          {loadingMore?"Loading…":"Load older messages"}
        </button>
      </div>
    )}
    {messagesLoading && <MessageListSkeleton />}
    {messagesError && !messagesLoading && (
      <div className="flex flex-col items-center gap-2 my-8">
        <p className="text-xs text-muted-foreground text-center">{messagesError}</p>
        <button onClick={() => { hapticLight(); fetchMessages(); }} className="text-[11px] text-primary underline">Retry</button>
      </div>
    )}
    {isVirtualized ? (
      <div style={{ height: totalHeight, position: "relative" }}>
        {virtualItems.map((vi) => {
          const row = flatRows[vi.index];
          if (!row) return null;
          return (
            <VirtualRow key={row.key} index={vi.index} start={vi.start} isDateSeparator={row.isDateSeparator} onMeasure={onMeasure}>
              {row.node}
            </VirtualRow>
          );
        })}
      </div>
    ) : (
    groupedTimeline.map(group => (
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
              return <CallEvent key={`call-${c.id}`} callType={c.call_type} status={c.status} direction={c.call_direction} durationSeconds={c.duration_seconds} createdAt={c.created_at} isMine={c.caller_id===userId} declinedAt={c.declined_at} />;
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
                      <p className="text-sm text-foreground/80 whitespace-pre-wrap break-words" style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}>{imp.content}</p>
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
              <MessageBubble key={stableMessageKey(msg)} msg={msg} isMine={msg.sender_id===userId}
                isDisappearing={!!msg.disappear_at&&msg.disappear_at!=="pending"&&!isVanishValue(msg.disappear_at)}
                isVanishing={isVanishValue(msg.disappear_at)}
                isHighlighted={searchResults.includes(msg.id)} isActiveResult={searchResults[searchIndex]===msg.id}
                repliedMsg={repliedMsg} partnerName={partnerName} userId={userId||""}
                isFirstInGroup={isFirstInGroup} isLastInGroup={isLastInGroup} isSenderChange={isSenderChange} partnerAvatar={partnerAvatar}
                onReply={() => { setReplyTo(msg); inputRef.current?.focus(); }}
                onLongPress={() => setContextMenuMsg(msg)}
                onPhotoView={(url, id) => setViewingPhoto({ url, id })}
                onLetterOpen={(content) => setViewingLetter({ content, isMine: msg.sender_id===userId })}
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
    ))
    )}
    {/* FIX: this used to check messages.length===0 only, so a conversation
        that had zero *live* messages but did have call history or imported
        WhatsApp content (both rendered from groupedTimeline, not from
        `messages`) still showed "Start your conversation" layered right
        above that real content. Check the same data actually being
        rendered above instead of a narrower proxy for it. */}
    {!messagesLoading && !messagesError && groupedTimeline.length===0 && (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <div className="h-14 w-14 rounded-full bg-muted flex items-center justify-center">
          <span className="text-xl">{isOffline && partnerId ? "📡" : "💬"}</span>
        </div>
        <p className="text-sm text-muted-foreground text-center max-w-[220px]">
          {!partnerId
            ? "Link with your partner in settings"
            : isOffline
              ? "You're offline and this chat hasn't been opened on this device before, so there's nothing saved yet. It'll be here once you're back online."
              : "Start your conversation"}
        </p>
      </div>
    )}
    <AnimatePresence>{partnerTyping && <TypingIndicator />}</AnimatePresence>
    <div ref={messagesEndRef} />
  </div>
  );
});

MessageTimeline.displayName = "MessageTimeline";

// PERF FIX (Hub open/close feels laggy): this is the actual message list —
// with a long conversation, real DOM nodes/Framer Motion instances for
// every visible row, a LayoutGroup, and (below VIRTUAL_ROW_THRESHOLD) an
// AnimatePresence over every bubble. It owns none of the Hub's own state,
// but showGridMenu lives in Chat.tsx (the parent), so every time the Hub
// opens or closes, Chat.tsx re-renders top to bottom — and until now that
// meant this entire component re-rendered and got fully reconciled too,
// even though nothing it actually displays changed. That's the lag: it was
// never the Hub panel's own (already-tuned, ~150ms) animation, it was this
// sitting behind it doing a full unnecessary re-render on every tap.
//
// Same fix as MessageBubble.tsx's own arePropsEqual: memo() with a
// comparator that checks the props that
// carry actual data, and ignores the identity of callback/handler props.
// Those (formatTime, fetchMessages, loadMoreMessages, onRetryMessage,
// onOpenSurprise, setReplyTo, setContextMenuMsg, setViewingPhoto,
// setViewingLetter, setReactingMsgId) are either React state setters
// (already stable) or plain functions Chat.tsx defines fresh on every
// render regardless of what changed — their *behavior* never depends on
// which render created the closure, they always act on Chat's current
// state, so skipping them from the comparison is safe and is exactly what
// stops an unrelated state change (like showGridMenu) from busting this.
const arePropsEqual = (
  prev: Readonly<MessageTimelineProps>,
  next: Readonly<MessageTimelineProps>,
) =>
  prev.hasMoreMessages === next.hasMoreMessages &&
  prev.loadingMore === next.loadingMore &&
  prev.messagesLoading === next.messagesLoading &&
  prev.messagesError === next.messagesError &&
  prev.groupedTimeline === next.groupedTimeline &&
  prev.userId === next.userId &&
  prev.messages === next.messages &&
  prev.searchResults === next.searchResults &&
  prev.searchIndex === next.searchIndex &&
  prev.partnerName === next.partnerName &&
  prev.partnerAvatar === next.partnerAvatar &&
  prev.partnerId === next.partnerId &&
  prev.allReactions === next.allReactions &&
  prev.mediaVisible === next.mediaVisible &&
  prev.reactingMsgId === next.reactingMsgId &&
  prev.partnerTyping === next.partnerTyping &&
  prev.surpriseStageById === next.surpriseStageById &&
  prev.bottomInset === next.bottomInset;

export default memo(MessageTimeline, arePropsEqual);

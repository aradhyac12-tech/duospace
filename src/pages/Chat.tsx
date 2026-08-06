import { motion, AnimatePresence, useMotionValue, useTransform } from "framer-motion";
import {
  Send, Paperclip, ImageIcon, FileText, Trash2, Camera, Mic, Play, Pause,
  Reply, Timer, TimerOff, Search, X, ChevronUp, ChevronDown, ChevronRight, Phone, Video,
  MoreVertical, MicOff, VideoOff, PhoneOff, Monitor, MonitorOff, Captions,
  Heart, Pin, Pencil, Check, WifiOff, BellOff,
} from "lucide-react";
import MessageStatus from "@/components/chat/MessageStatus";
import MessageReactions, { useReactionsChannel } from "@/components/chat/MessageReactions";
import { dispatchEmojiEffect } from "@/components/EmojiScreenEffect";
import TypingIndicator from "@/components/chat/TypingIndicator";
import ReplyPreview from "@/components/chat/ReplyPreview";
import QuotedMessage from "@/components/chat/QuotedMessage";
import PhotoViewer from "@/components/chat/PhotoViewer";
import GridMenu, { HubButton } from "@/components/chat/GridMenu";
import CallEvent from "@/components/chat/CallEvent";
import MessageContextMenu from "@/components/chat/MessageContextMenu";
import IncomingCallOverlay from "@/components/IncomingCallOverlay";
import ChatSurpriseHost from "@/components/chat/ChatSurpriseHost";
import ScheduledMessagePicker from "@/components/chat/ScheduledMessagePicker";
import LoveLetter from "@/components/chat/LoveLetter";
import LipReadingOverlay from "@/components/LipReadingOverlay";
import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from "react";
import { useLongPress } from "@/hooks/useLongPress";
import { useNavigate } from "react-router-dom";
import { useTheme } from "@/contexts/ThemeContext";
import { resolveWallpaperStyle } from "@/lib/wallpapers";
import DisappearGestureHandle from "@/components/chat/DisappearGestureHandle";
import DisappearRing from "@/components/chat/DisappearRing";
import { supabase } from "@/integrations/supabase/client";
import { playMessageSound, playCallSound } from "@/lib/sounds";
import { hapticTick, hapticLight, hapticMedium, hapticSelection, hapticWarning, hapticError, hapticMessageSent, hapticSend, hapticSwipe } from "@/lib/haptics";
import { routePreload } from "@/App";
import { useAuth } from "@/hooks/useAuth";
import { useE2E } from "@/hooks/useE2E";
import storage from "@/lib/storage";
import { useCall } from "@/contexts/CallContext";
import { useMediaPermission } from "@/components/PermissionDeniedSheet";
import { useToast } from "@/hooks/use-toast";
import { invokeEdgeFunction } from "@/lib/edgeFunction";
import { extractErrorMessage } from "@/lib/errorMessage";
import { resolveSignedUrl } from "@/lib/signedStorageUrl";
import { logError, logWarn } from "@/lib/telemetry";
import { callRoomLimiter, scheduledMsgLimiter, formatRetryDelay } from "@/lib/rateLimit";
import { useReconnectRefetch, createSendDedup } from "@/lib/networkState";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuTrigger, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";

// FIX AUDIT #15: Module-level dedup guard prevents duplicate sends
// on rapid double-taps or reconnect storms.
const sendDedup = createSendDedup();

// ─── Types ───────────────────────────────────────────────────────────────────
interface Message {
  id: string;
  content: string | null;
  sender_id: string;
  receiver_id: string;
  message_type: string;
  file_url: string | null;
  file_name: string | null;
  created_at: string;
  is_read: boolean;
  reply_to_id: string | null;
  disappear_at: string | null;
  edited_at?: string | null;
  is_pinned?: boolean;
}

interface DecryptedMessage extends Message {
  decryptedContent: string | null;
}

interface CallEntry {
  id: string;
  caller_id: string;
  receiver_id: string | null;
  call_type: string;
  status: string;
  call_direction: string;
  duration_seconds: number | null;
  created_at: string;
}

// WA-01 FIX: Add ImportedMessage type so imported WhatsApp chats
// can be fetched from the DB and rendered in the timeline.
interface ImportedMessage {
  id: string;
  sender_name: string;
  content: string | null;
  original_timestamp: string;
  created_at: string;
  is_self: boolean;
}

type TimelineItem =
  | { type: "message";  data: DecryptedMessage }
  | { type: "call";     data: CallEntry }
  | { type: "imported"; data: ImportedMessage };

// FIX: disappear delay is now configurable (default 30s)
const DISAPPEAR_OPTIONS = [
  { label: "10 seconds",  value: 10_000 },
  { label: "30 seconds",  value: 30_000 },
  { label: "5 minutes",   value: 5 * 60_000 },
  { label: "1 hour",      value: 60 * 60_000 },
  { label: "1 day",       value: 24 * 60 * 60_000 },
];
const DEFAULT_DISAPPEAR_MS = 30_000;
// No hard cap on messages — load 200 per page with infinite scroll.
// Cloud + local IndexedDB caching means history loads instantly on revisit.
const PAGE_SIZE = 200;

const formatCallDuration = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
  return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
};

// ─── VoiceMessagePlayer ───────────────────────────────────────────────────────
const VoiceMessagePlayer = ({ src, isMine }: { src: string; isMine: boolean }) => {
  const [playing, setPlaying]     = useState(false);
  const [progress, setProgress]   = useState(0);
  const [duration, setDuration]   = useState(0);
  const [waveform, setWaveform]   = useState<number[]>(Array(20).fill(0.3));
  const audioRef     = useRef<HTMLAudioElement>(null);
  const analyserRef  = useRef<AnalyserNode | null>(null);
  const audioCtxRef  = useRef<AudioContext | null>(null);
  const srcConnected = useRef(false);
  const animFrameRef = useRef<number>(0);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime   = () => setProgress(a.currentTime);
    const onLoaded = () => setDuration(a.duration);
    const onEnded  = () => { setPlaying(false); setProgress(0); setWaveform(Array(20).fill(0.3)); cancelAnimationFrame(animFrameRef.current); };
    a.addEventListener("timeupdate",    onTime);
    a.addEventListener("loadedmetadata",onLoaded);
    a.addEventListener("ended",         onEnded);
    return () => {
      a.removeEventListener("timeupdate",    onTime);
      a.removeEventListener("loadedmetadata",onLoaded);
      a.removeEventListener("ended",         onEnded);
      cancelAnimationFrame(animFrameRef.current);
      if (audioCtxRef.current && audioCtxRef.current.state !== "closed") audioCtxRef.current.close();
    };
  }, []);

  const startVisualizer = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    try {
      if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
        audioCtxRef.current = new AudioContext();
        srcConnected.current = false;
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === "suspended") ctx.resume();
      if (!srcConnected.current) {
        const src  = ctx.createMediaElementSource(a);
        const anal = ctx.createAnalyser();
        anal.fftSize = 64;
        src.connect(anal); anal.connect(ctx.destination);
        analyserRef.current  = anal;
        srcConnected.current = true;
      }
      const update = () => {
        if (!analyserRef.current) return;
        const d = new Uint8Array(analyserRef.current.frequencyBinCount);
        analyserRef.current.getByteFrequencyData(d);
        setWaveform(Array(20).fill(0).map((_,i) => Math.max(0.15,(d[i]||0)/255)));
        animFrameRef.current = requestAnimationFrame(update);
      };
      update();
    } catch { /* already connected */ }
  }, []);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (playing) { a.pause(); cancelAnimationFrame(animFrameRef.current); }
    else          { a.play(); startVisualizer(); }
    setPlaying(!playing);
  };

  const fmt = (s: number) => (!s || !isFinite(s)) ? "0:00" : `${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,"0")}`;

  const seekTo = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = audioRef.current;
    if (!a || !duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    a.currentTime = ((e.clientX - r.left) / r.width) * duration;
  };

  return (
    <div className="flex items-center gap-2.5 min-w-[180px]">
      <audio ref={audioRef} src={src} preload="metadata" crossOrigin="anonymous" />
      <button onClick={() => { hapticTick(); toggle(); }} aria-label={playing ? "Pause voice message" : "Play voice message"}
        className={`h-9 w-9 rounded-full flex items-center justify-center shrink-0 transition-colors active:scale-95 ${
          isMine ? "bg-primary-foreground/20 hover:bg-primary-foreground/30" : "bg-accent/15 hover:bg-accent/25"
        }`}>
        {playing
          ? <Pause className={`h-4 w-4 ${isMine?"text-primary-foreground":"text-accent"}`} aria-hidden="true" />
          : <Play className={`h-4 w-4 ml-0.5 ${isMine?"text-primary-foreground":"text-accent"}`} aria-hidden="true" />}
      </button>
      <div className="flex-1 space-y-1">
        <div className="flex items-end gap-[2px] h-5 cursor-pointer" onClick={(e) => { hapticTick(); seekTo(e); }}>
          {waveform.map((h,i) => (
            <div key={i} className={`flex-1 rounded-full transition-all duration-75 ${
              duration && (i/waveform.length)<=(progress/duration)
                ? (isMine?"bg-primary-foreground/70":"bg-accent/70")
                : (isMine?"bg-primary-foreground/25":"bg-foreground/15")
            }`} style={{ height:`${Math.max(15,h*100)}%` }} />
          ))}
        </div>
        <p className={`text-[10px] font-mono ${isMine?"text-primary-foreground/60":"text-muted-foreground"}`}>{fmt(progress>0?progress:duration)}</p>
      </div>
    </div>
  );
};

// ─── PinnedMessageBanner ──────────────────────────────────────────────────────
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

// ─── MessageBubble ────────────────────────────────────────────────────────────
const MessageBubble = ({
  msg, isMine, isDisappearing, isHighlighted, isActiveResult,
  repliedMsg, partnerName, userId,
  isFirstInGroup, isLastInGroup, partnerAvatar,
  onReply, onLongPress, onPhotoView, formatTime,
  allReactions, mediaVisible, isReactingTo, onReactionPickerClose,
}: {
  msg: DecryptedMessage; isMine: boolean; isDisappearing: boolean;
  isHighlighted: boolean; isActiveResult: boolean;
  repliedMsg: DecryptedMessage | null; partnerName: string; userId: string;
  isFirstInGroup: boolean; isLastInGroup: boolean; partnerAvatar: string | null;
  onReply: () => void; onLongPress: () => void;
  onPhotoView: (url: string) => void; formatTime: (iso: string) => string;
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
      className={`flex ${isMine?"justify-end":"justify-start"} group ${isFirstInGroup ? "pt-2" : "pt-[1px]"} ${
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
        <div className={`relative rounded-2xl px-3 py-2 select-none ${
          isMine
            ? `bg-primary text-primary-foreground ${isLastInGroup ? "rounded-br-md" : "rounded-br-2xl"}`
            : `bg-card/70 backdrop-blur-md border border-border/30 ${isLastInGroup ? "rounded-bl-md" : "rounded-bl-2xl"}`
        } ${isDisappearing ? "ring-1 ring-primary/20" : ""}`}>
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
          {msg.message_type==="voice" && msg.file_url && <VoiceMessagePlayer src={msg.file_url} isMine={isMine} />}
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
          {/* Image */}
          {msg.message_type==="image" && msg.file_url && (
            mediaVisible!==false ? (
              <img onClick={() => { hapticLight(); onPhotoView(msg.file_url!); }} src={msg.file_url} alt="shared"
                className="rounded-xl mb-1 max-h-44 object-cover w-full cursor-pointer active:scale-[0.98] transition-transform" />
            ) : (
              <button onClick={() => { hapticLight(); onPhotoView(msg.file_url!); }}
                className={`flex items-center gap-2 mb-1 rounded-xl px-3 py-2.5 w-full ${isMine?"bg-primary-foreground/15":"bg-muted/50"}`}>
                <ImageIcon className="h-4 w-4 shrink-0 opacity-50" />
                <span className="text-xs opacity-60">Photo — tap to view</span>
              </button>
            )
          )}
          {/* File */}
          {msg.message_type==="file" && msg.file_name && (
            <a href={msg.file_url||"#"} target="_blank" rel="noopener"
              className={`flex items-center gap-2 mb-1 rounded-lg px-2 py-1.5 ${isMine?"bg-primary-foreground/15":"bg-muted/50"}`}>
              <FileText className="h-3.5 w-3.5 shrink-0 opacity-50" />
              <span className="text-xs truncate">{msg.file_name}</span>
            </a>
          )}
          {/* Text */}
          {msg.message_type!=="voice" && msg.message_type!=="letter" && msg.message_type!=="nudge" && msg.decryptedContent && (
            <p className="text-[14px] leading-relaxed whitespace-pre-wrap">{msg.decryptedContent}</p>
          )}
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
            {isMine && <MessageStatus isRead={msg.is_read} isMine={isMine} />}
          </div>
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

// ─── Main Chat Component ──────────────────────────────────────────────────────
const Chat = () => {
  const [message, setMessage]           = useState("");
  const [messages, setMessages]         = useState<DecryptedMessage[]>([]);
  const [callHistory, setCallHistory]   = useState<CallEntry[]>([]);
  // WA-01 FIX: imported WhatsApp messages state
  const [importedMessages, setImportedMessages] = useState<ImportedMessage[]>([]);
  const [showClearDialog, setShowClearDialog] = useState(false);
  const [showAttach, setShowAttach]     = useState(false);
  const [showGridMenu, setShowGridMenu] = useState(false);
  const [viewingPhoto, setViewingPhoto] = useState<string|null>(null);
  const [partnerId, setPartnerId]       = useState<string|null>(null);
  const [partnerName, setPartnerName]   = useState("");
  const [partnerAvatar, setPartnerAvatar] = useState<string|null>(null);
  const [replyTo, setReplyTo]           = useState<DecryptedMessage|null>(null);
  // FIX: disappear mode now tracks delay ms, not just a boolean
  const [disappearMode, setDisappearMode] = useState(false);
  const [disappearMs, setDisappearMs]   = useState(DEFAULT_DISAPPEAR_MS);
  const [showDisappearSheet, setShowDisappearSheet] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(true);
  const [messagesError, setMessagesError] = useState<string|null>(null);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [loadingMore, setLoadingMore]   = useState(false);
  // FIX: track load-more separately to not trigger auto-scroll
  const isLoadingMoreRef = useRef(false);
  const navigate = useNavigate();
  const [searchOpen, setSearchOpen]     = useState(false);
  const [searchQuery, setSearchQuery]   = useState("");
  const [searchResults, setSearchResults] = useState<string[]>([]);
  const [searchIndex, setSearchIndex]   = useState(0);
  const searchInputRef  = useRef<HTMLInputElement>(null);
  const inputRef        = useRef<HTMLInputElement>(null);
  const [isRecording, setIsRecording]   = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [partnerTyping, setPartnerTyping] = useState(false);
  const typingTimeoutRef  = useRef<ReturnType<typeof setTimeout>|null>(null);
  const lastTypingRef     = useRef<number>(0);
  const presenceChannelRef = useRef<ReturnType<typeof supabase.channel>|null>(null);
  const { ensure: ensureMedia, permissionSheet } = useMediaPermission();
  const fileInputRef    = useRef<HTMLInputElement>(null);
  const imageInputRef   = useRef<HTMLInputElement>(null);
  const cameraInputRef  = useRef<HTMLInputElement>(null);
  const messagesEndRef  = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  // BUG FIX ("scroll loading" — visible scroll animation every time chat
  // opens/loads): the auto-scroll effect used to fire `scrollIntoView`
  // with `behavior: "smooth"` on every messages.length change, including
  // the very first cold-start load of a conversation — so the person
  // watched the whole conversation visibly fly by from top to bottom
  // every single time they opened a chat. `didInitialScrollRef` tracks,
  // per conversation, whether that first jump-to-bottom has already
  // happened; once it has, later genuinely-new messages still get the
  // nice smooth slide-in, but the first paint never animates — it should
  // just already *be* at the bottom, with anything older loading in
  // silently behind it (see the layout effect below and loadMoreMessages).
  const didInitialScrollRef = useRef(false);
  // Captured right before fetching an older page so the scroll position
  // can be restored after older messages are prepended — otherwise every
  // "Load older messages" tap visibly yanks the viewport since the
  // content the person was reading just got pushed further down the page.
  const pendingScrollRestoreRef = useRef<{ height: number; top: number } | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder|null>(null);
  const audioChunksRef   = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval>|null>(null);
  // FIX: cancel flag for mic button race condition
  const recordingCancelledRef = useRef(false);
  const { chatWallpaper, colorMode, appName, appIcon } = useTheme();
  // The Dynamic Sky wallpaper (src/lib/dynamicSky.ts) is computed fresh from
  // the current time on every render — this just forces a render once a
  // minute so it keeps drifting even during an idle chat with no new
  // messages or other state changes to naturally trigger a re-paint.
  const [, forceSkyTick] = useState(0);
  useEffect(() => {
    if (chatWallpaper !== "w-dynamic-sky") return;
    const id = setInterval(() => forceSkyTick(t => t + 1), 60_000);
    return () => clearInterval(id);
  }, [chatWallpaper]);
  const { user } = useAuth();
  const { ready: e2eReady, encrypt, decrypt } = useE2E(user?.id, partnerId);
  const { toast } = useToast();
  const [contextMenuMsg, setContextMenuMsg] = useState<DecryptedMessage|null>(null);
  const [reactingMsgId, setReactingMsgId] = useState<string|null>(null);
  const allReactions = useReactionsChannel(user?.id, partnerId);
  const [showSchedulePicker, setShowSchedulePicker] = useState(false);
  const [showLoveLetter, setShowLoveLetter]   = useState(false);
  const [partnerOnline, setPartnerOnline]     = useState(false);
  const [showLipReading, setShowLipReading]   = useState(false);
  // Edit feature
  const [editingMsg, setEditingMsg]     = useState<DecryptedMessage|null>(null);
  const [editText, setEditText]         = useState("");
  // Pinned message
  const [pinnedMsg, setPinnedMsg]       = useState<DecryptedMessage|null>(null);
  // Nudge cooldown
  const lastNudgeRef = useRef<number>(0);
  // Show nudge full-screen flash
  const [nudgeFlash, setNudgeFlash]     = useState(false);

  const [mediaVisible] = useState(() => {
    const s = storage.get("duo-media-visibility");
    return s===null ? true : s==="true";
  });
  const markedReadRef = useRef<Set<string>>(new Set());

  const {
    joinCall, leaveCall, toggleAudio, toggleVideo, toggleScreenShare,
    switchCamera, listCameras,
    isAudioOn, isVideoOn, isScreenSharing, callState,
    localVideoRef, remoteVideoRef, screenShareRef,
    networkQuality: callNetworkQuality, participantCount, error: callError,
    callDuration,
  } = useCall();
  const [isStartingCall, setIsStartingCall] = useState(false);
  // BUG FIX (call latency): the call screen now appears the instant the
  // button is tapped (isStartingCall), before the network setup that used
  // to gate it has even started — see the render gate below. That means
  // the hang-up button is now reachable *during* that setup, which wasn't
  // possible before. This flag lets a cancel during that window stop
  // startCall()'s in-flight async work from finishing the job (joining a
  // call the person already tried to back out of) instead of just
  // resetting local UI state and letting it join anyway a moment later.
  const callCancelledRef = useRef(false);
  const [currentCallId, setCurrentCallId]   = useState<string|null>(null);

  // FIX AUDIT #15: re-fetch messages when network is restored or app resumes from background
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useReconnectRefetch(useCallback(() => { fetchMessages(); }, [user, partnerId]));

  // ─── Decrypt helper ───────────────────────────────────────────────────────
  const decryptMessages = useCallback(async (msgs: Message[]): Promise<DecryptedMessage[]> => {
    return Promise.all(msgs.map(async msg => ({
      ...msg,
      // FIX: also decrypt "letter" type messages
      decryptedContent: (msg.message_type==="text" || msg.message_type==="letter")
        ? await decrypt(msg.content)
        : msg.content,
      // BUG FIX: file_url was stored as a getPublicUrl() output against the
      // private "chat-files" bucket, which 403s — every image/voice/file
      // attachment rendered broken. Resolve to a real signed URL here.
      file_url: msg.file_url ? await resolveSignedUrl("chat-files", msg.file_url) : msg.file_url,
    })));
  }, [decrypt]);

  // ─── Fetch partner ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!user) return;
    supabase.from("profiles").select("partner_id").eq("user_id",user.id).single()
      .then(({ data }) => {
        if (data?.partner_id) {
          setPartnerId(data.partner_id);
          supabase.from("profiles").select("display_name,avatar_url,pet_name").eq("user_id",data.partner_id).single()
            .then(({ data: pp }) => {
              if (pp) { setPartnerName(pp.pet_name||pp.display_name||"Partner"); setPartnerAvatar(pp.avatar_url); }
            });
        }
      });
  }, [user]);

  // ─── Fetch messages (paginated) ───────────────────────────────────────────
  const fetchMessages = useCallback(async (beforeCreatedAt?: string) => {
    if (!user || !partnerId) return;
    if (!beforeCreatedAt) { setMessagesLoading(true); setMessagesError(null); }

    let query: any = supabase.from("messages").select("id,sender_id,receiver_id,content,message_type,file_url,file_name,is_read,reply_to_id,disappear_at,deleted_by_sender,deleted_by_receiver,created_at")
      .or(`and(sender_id.eq.${user.id},receiver_id.eq.${partnerId}),and(sender_id.eq.${partnerId},receiver_id.eq.${user.id})`)
      .neq("deleted_by_sender", true)
      .neq("deleted_by_receiver", true)
      .order("created_at", { ascending: false })
      .limit(PAGE_SIZE + 1);

    if (beforeCreatedAt) query = query.lt("created_at", beforeCreatedAt);

    const { data, error } = await query;
    if (error) { setMessagesError("Couldn't load messages."); setMessagesLoading(false); return; }

    if (data) {
      // FIX BUG-04: Determine hasMore from raw DB result count BEFORE filtering
      // out expired messages. Previously the filter ran first, so valid.length could
      // be <51 even when the DB had more pages (e.g. 3 expired → valid=48 → hasMore=false).
      const hasMore = (data as Message[]).length > PAGE_SIZE;
      const rawPage = hasMore ? (data as Message[]).slice(0, PAGE_SIZE) : (data as Message[]);
      const now = new Date();
      const valid = rawPage.filter(m =>
        !m.disappear_at || m.disappear_at==="pending" || new Date(m.disappear_at)>now
      );
      const pageItems = [...valid].reverse();
      const decrypted = await decryptMessages(pageItems);

      if (beforeCreatedAt) {
        setMessages(prev => [...decrypted, ...prev]);
      } else {
        setMessages(decrypted);
        // Detect pinned message
        const pinned = decrypted.find(m => m.is_pinned);
        if (pinned) setPinnedMsg(pinned);
      }
      setHasMoreMessages(hasMore);
    }
    setMessagesLoading(false);
  }, [user, partnerId, decryptMessages]);

  useEffect(() => {
    if (!user || !partnerId) return;
    // FIX: Wait until E2E keys (mine + partner's) are ready before decrypting,
    // otherwise every historical message renders as "[🔒 Encrypted]" and gets
    // cached that way in state. Re-runs when e2eReady flips true so the
    // conversation appears the moment key exchange completes.
    if (!e2eReady) return;
    markedReadRef.current = new Set();
    didInitialScrollRef.current = false; // new conversation — next load jumps instantly, no smooth animation
    pendingScrollRestoreRef.current = null;
    fetchMessages();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, partnerId, e2eReady]);

  // FIX: load more passes the oldest created_at (not ID) — avoids stale messages dependency
  const loadMoreMessages = async () => {
    if (!hasMoreMessages || loadingMore || messages.length===0) return;
    isLoadingMoreRef.current = true;
    setLoadingMore(true);
    // Snapshot scroll position so the layout effect below can keep the
    // person's current reading position fixed once older messages are
    // prepended above it (see pendingScrollRestoreRef).
    if (messagesContainerRef.current) {
      pendingScrollRestoreRef.current = {
        height: messagesContainerRef.current.scrollHeight,
        top: messagesContainerRef.current.scrollTop,
      };
    }
    // FIX BUG-05: wrap in try/finally so isLoadingMoreRef is always reset even when
    // fetchMessages returns early due to a network/DB error. Previously a fetch error
    // left isLoadingMoreRef=true permanently, which blocked the auto-scroll effect
    // (it guards with `if (isLoadingMoreRef.current) return`) for the rest of the session.
    try {
      await fetchMessages(messages[0].created_at);
    } finally {
      setLoadingMore(false);
      isLoadingMoreRef.current = false;
    }
  };

  // ─── Call history ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!user || !partnerId) return;
    const fetchCalls = async () => {
      const { data } = await supabase.from("call_history").select("id,caller_id,receiver_id,room_name,call_type,call_direction,status,started_at,ended_at,duration_seconds,created_at")
        .or(`and(caller_id.eq.${user.id},receiver_id.eq.${partnerId}),and(caller_id.eq.${partnerId},receiver_id.eq.${user.id})`)
        .order("created_at",{ ascending:true }).limit(200);
      if (data) setCallHistory(data as CallEntry[]);
    };
    fetchCalls();
    const ch = supabase.channel("call-history-rt")
      .on("postgres_changes",{ event:"*",schema:"public",table:"call_history" },() => fetchCalls())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [user, partnerId]);

  // ─── Imported WhatsApp messages ───────────────────────────────────────────
  // WA-01 FIX: Fetch imported_chats from DB and keep in sync via realtime.
  // Previously this table was write-only — data was inserted but never queried
  // here, so imported messages never appeared anywhere in the UI.
  // WA-08 FIX: this only fetched rows owned by the current user, so whichever
  // partner did NOT run the import never saw the imported chat at all — even
  // though RLS ("owner_id = auth.uid() OR owner_id = get_partner_id(auth.uid())")
  // already allowed it. Now fetches/subscribes for both owner_id values.
  useEffect(() => {
    if (!user || !partnerId) return;
    const fetchImported = async () => {
      const { data } = await supabase
        .from("imported_chats" as any)
        .select("id,sender_name,content,original_timestamp,created_at,is_self")
        .in("owner_id", [user.id, partnerId])
        .order("original_timestamp", { ascending: true });
      if (data) setImportedMessages(data as unknown as ImportedMessage[]);
    };
    fetchImported();
    // Listen for new batches being inserted (import in progress), from either
    // partner. postgres_changes only supports one equality filter per
    // listener, so register one per owner_id and dedupe by row id.
    const seenIds = new Set<string>();
    const handleInsert = (payload: { new: Record<string, unknown> }) => {
      const row = payload.new as unknown as ImportedMessage;
      if (seenIds.has(row.id)) return;
      seenIds.add(row.id);
      setImportedMessages(prev => [...prev, row]);
    };
    const ch = supabase.channel(`imported-rt-${[user.id, partnerId].sort().join("-")}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "imported_chats",
          filter: `owner_id=eq.${user.id}` }, handleInsert)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "imported_chats",
          filter: `owner_id=eq.${partnerId}` }, handleInsert)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [user, partnerId]);

  // ─── Realtime messages ────────────────────────────────────────────────────
  useEffect(() => {
    if (!user) return;
    // FIX BUG-02: Use unique channel name per user to avoid cross-user subscriptions.
    // Also add server-side filter on INSERT so only messages where the current user
    // is sender or receiver are delivered. Without this filter every client received
    // every INSERT on the entire table, leaking metadata (sender_id, receiver_id,
    // file_url, timestamps) to all authenticated users.
    // Note: Supabase postgres_changes only supports a single equality filter per listener,
    // so we register two INSERT listeners — one for receiver_id and one for sender_id —
    // and deduplicate by message ID in the handler.
    const seenIds = new Set<string>();
    const handleInsert = async (payload: { new: Record<string, unknown> }) => {
      const msg = payload.new as unknown as Message;
      if (seenIds.has(msg.id)) return; // deduplicate the two listeners
      seenIds.add(msg.id);
      const decrypted = (msg.message_type==="text"||msg.message_type==="letter")
        ? await decrypt(msg.content) : msg.content;
      const resolvedFileUrl = msg.file_url ? await resolveSignedUrl("chat-files", msg.file_url) : msg.file_url;
      const dm: DecryptedMessage = { ...msg, decryptedContent: decrypted, file_url: resolvedFileUrl };
      setMessages(prev => [...prev, dm]);
      if (msg.sender_id !== user.id) {
        // Nudge flash
        if (msg.message_type==="nudge") {
          setNudgeFlash(true);
          hapticMedium();
          setTimeout(() => setNudgeFlash(false), 1500);
        }
        playMessageSound();
        if (decrypted) {
          const loveEmojis = ["❤️","♥️","💕","💖","💗","😍","🥰","💘","💝"];
          for (const e of loveEmojis) { if (decrypted.includes(e)) { dispatchEmojiEffect(e); break; } }
        }
      }
    };
    const ch = supabase.channel(`messages-rt-${user.id}`)
      .on("postgres_changes",{ event:"INSERT",schema:"public",table:"messages",filter:`receiver_id=eq.${user.id}` }, handleInsert)
      .on("postgres_changes",{ event:"INSERT",schema:"public",table:"messages",filter:`sender_id=eq.${user.id}` }, handleInsert)
      .on("postgres_changes",{ event:"DELETE",schema:"public",table:"messages" }, (payload) => {
        const id = (payload.old as any)?.id;
        if (id) setMessages(prev => prev.filter(m => m.id!==id));
      })
      .on("postgres_changes",{ event:"UPDATE",schema:"public",table:"messages" }, async (payload) => {
        const updated = payload.new as Message;
        if ((updated as any).deleted_by_sender||(updated as any).deleted_by_receiver) {
          setMessages(prev => prev.filter(m => m.id!==updated.id)); return;
        }
        // FIX: re-decrypt edited content
        const newContent = (updated.message_type==="text"||updated.message_type==="letter")
          ? await decrypt(updated.content) : updated.content;
        setMessages(prev => prev.map(m => m.id===updated.id
          ? { ...m, is_read:updated.is_read, disappear_at:updated.disappear_at,
              content:updated.content, decryptedContent:newContent,
              edited_at:(updated as any).edited_at, is_pinned:(updated as any).is_pinned }
          : m));
        // Update pinned banner
        if ((updated as any).is_pinned) {
          const dm: DecryptedMessage = { ...updated, decryptedContent: newContent };
          setPinnedMsg(dm);
        } else if (!(updated as any).is_pinned) {
          setPinnedMsg(prev => prev?.id===updated.id ? null : prev);
        }
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [user, decrypt]);

  // BUG FIX ("scroll loading" — chat visibly scrolls from top to bottom
  // BUG FIX ("scroll loading" — chat visibly scrolls from top to bottom
  // every time it loads): this used to always use `behavior: "smooth"`,
  // including the very first paint of a freshly-opened conversation — so
  // the whole message list visibly flew past on every cold start. Now the
  // very first jump-to-bottom for a conversation (tracked by
  // didInitialScrollRef, reset whenever partnerId changes) is instant and
  // runs in a layout effect — synchronously after the DOM updates but
  // before the browser paints, so the first frame the person actually
  // sees already has the last message in view. Only genuinely new
  // messages arriving *after* that get the nice smooth slide-in. Also
  // watches callHistory/importedMessages so a finished call or a batch of
  // WhatsApp-imported chat still lands at the bottom.
  //
  // "Load older messages" restore lives in this same effect rather than a
  // separate one watching `messages`: both fire off the same
  // messages-changed render, and `isLoadingMoreRef` alone isn't a safe way
  // to tell them apart — loadMoreMessages's `finally` block can reset that
  // ref synchronously before React ever commits the state update it's
  // guarding, since nothing awaits between them. Checking
  // `pendingScrollRestoreRef` instead is deterministic: it's only ever
  // non-null while an older-messages fetch is genuinely in flight, so
  // there's no window where both this effect's "jump to bottom" and the
  // position restore could both fire for the same render and fight.
  useLayoutEffect(() => {
    const container = messagesContainerRef.current;
    const pendingRestore = pendingScrollRestoreRef.current;
    if (pendingRestore && container) {
      pendingScrollRestoreRef.current = null;
      container.scrollTop = pendingRestore.top + (container.scrollHeight - pendingRestore.height);
      return;
    }
    if (isLoadingMoreRef.current) return;
    const el = messagesEndRef.current;
    if (!el) return;
    const isColdStart = !didInitialScrollRef.current;
    if (isColdStart) {
      if (messages.length===0 && callHistory.length===0 && importedMessages.length===0) return;
      didInitialScrollRef.current = true;
    }
    el.scrollIntoView({ behavior: isColdStart ? "auto" : "smooth" });
    // A short follow-up catches late layout shifts (a big WhatsApp import
    // landing at once, or images still loading) that can leave a long
    // chat short of the bottom.
    const t = setTimeout(() => {
      // Don't fight a load-older-messages restore that may have started
      // since this timeout was scheduled.
      if (pendingScrollRestoreRef.current) return;
      messagesEndRef.current?.scrollIntoView({ behavior: isColdStart ? "auto" : "smooth" });
    }, 350);
    return () => clearTimeout(t);
  }, [messages.length, callHistory.length, importedMessages.length]);

  // ─── Scheduled message ────────────────────────────────────────────────────
  const handleScheduleMessage = useCallback(async (sendAt: Date) => {
    if (!message.trim()||!user||!partnerId) return;

    // FIX AUDIT #6: rate-limit scheduled message submissions
    if (!scheduledMsgLimiter.allow()) {
      const wait = formatRetryDelay(scheduledMsgLimiter.retryAfterMs());
      toast({ title: "Slow down", description: `Too many scheduled messages. Try again in ${wait}.`, variant: "destructive" });
      return;
    }

    const text = message;
    setMessage(""); setShowSchedulePicker(false);
    const enc = e2eReady ? await encrypt(text) : text;
    const { error } = await supabase.from("scheduled_messages" as any).insert({
      sender_id:user.id, receiver_id:partnerId, content:enc,
      send_at:sendAt.toISOString(), message_type:"text",
      disappear_at:disappearMode?"pending":null,
    });
    if (error) toast({ title:"Couldn't schedule", description:error.message, variant:"destructive" });
    else toast({ title:"Message scheduled! ⏰", description:`Sends ${sendAt.toLocaleString([],{weekday:"short",hour:"2-digit",minute:"2-digit"})}` });
  }, [message,user,partnerId,encrypt,e2eReady,disappearMode,toast]);

  // ─── Love letter ──────────────────────────────────────────────────────────
  const handleSendLoveLetter = useCallback(async (subject: string, body: string) => {
    if (!user||!partnerId) return;
    setShowLoveLetter(false);
    const content = `💌 **${subject}**\n\n${body}`;
    const enc = e2eReady ? await encrypt(content) : content;
    hapticMessageSent();
    const { error } = await supabase.from("messages").insert({
      sender_id:user.id, receiver_id:partnerId, content:enc,
      message_type:"letter", disappear_at:disappearMode?"pending":null,
    });
    if (error) toast({ title:"Failed to send letter", variant:"destructive" });
    else toast({ title:"Letter delivered 💌" });
  }, [user,partnerId,encrypt,e2eReady,disappearMode,toast]);

  // ─── Mark read + disappear_at ─────────────────────────────────────────────
  // FIX BUG-08: Outgoing disappearing messages (sent by current user) are inserted
  // with disappear_at="pending". They only got a real timestamp when the *partner*
  // marked them as read. If the partner never opened the app, these stayed "pending"
  // forever — the cron job skips "pending" rows, so they never expired.
  //
  // Fix: resolve outgoing "pending" messages immediately on send (sender-side timer).
  // The disappear timer starts when the sender sends, not when the receiver reads.
  // This matches the expected UX for disappearing messages.
  useEffect(() => {
    if (!user||!partnerId) return;
    // Resolve outgoing "pending" disappearing messages for the sender
    const outgoingPending = messages.filter(
      m => m.sender_id===user.id && m.disappear_at==="pending" && !markedReadRef.current.has(`sent-${m.id}`)
    );
    if (outgoingPending.length) {
      outgoingPending.forEach(m => markedReadRef.current.add(`sent-${m.id}`));
      const disappearAt = new Date(Date.now()+disappearMs).toISOString();
      supabase.from("messages")
        .update({ disappear_at: disappearAt } as any)
        .in("id", outgoingPending.map(m=>m.id))
        .eq("sender_id", user.id); // safety: only update own messages
      setMessages(prev => prev.map(m =>
        outgoingPending.some(p=>p.id===m.id) ? { ...m, disappear_at: disappearAt } : m
      ));
    }

    // Mark received messages as read and resolve their pending disappear_at
    const unread = messages.filter(m => m.sender_id===partnerId && !m.is_read && !markedReadRef.current.has(m.id));
    if (!unread.length) return;
    unread.forEach(m => markedReadRef.current.add(m.id));
    const receivedDisappearAt = new Date(Date.now()+disappearMs).toISOString();
    const pendingIds  = unread.filter(m => m.disappear_at==="pending").map(m=>m.id);
    const normalIds   = unread.filter(m => m.disappear_at!=="pending").map(m=>m.id);
    const run = async () => {
      if (normalIds.length) await supabase.from("messages").update({ is_read:true }).in("id",normalIds);
      if (pendingIds.length) await supabase.from("messages").update({ is_read:true, disappear_at:receivedDisappearAt }).in("id",pendingIds);
      setMessages(prev => prev.map(m => {
        if (!unread.some(u=>u.id===m.id)) return m;
        return { ...m, is_read:true, disappear_at: pendingIds.includes(m.id)?receivedDisappearAt:m.disappear_at };
      }));
    };
    run();
  }, [messages,user,partnerId,disappearMs]);

  // BUG FIX / POLISH (premium disappearing-message behavior): this used to
  // batch-check every 5s and mass-filter whatever had expired, so messages
  // could sit up to 5s past their real expiry and several could vanish in
  // one visible clump. Each disappearing message now gets its own
  // setTimeout fired at the *exact* instant it expires, so it disappears
  // precisely on time and plays its own individual exit animation instead
  // of several popping at once. DB deletion still happens server-side via
  // the pg_cron sweep (see delete_expired_messages) — this only ever
  // touches local UI state.
  const disappearTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(() => {
    const scheduled = disappearTimersRef.current;
    const stillPresent = new Set<string>();
    for (const m of messages) {
      if (!m.disappear_at || m.disappear_at === "pending") continue;
      stillPresent.add(m.id);
      if (scheduled.has(m.id)) continue; // expiry time never changes once resolved — don't reschedule
      const delay = new Date(m.disappear_at).getTime() - Date.now();
      const remove = () => {
        scheduled.delete(m.id);
        setMessages(prev => prev.filter(x => x.id !== m.id));
      };
      if (delay <= 0) { remove(); continue; }
      scheduled.set(m.id, setTimeout(remove, delay));
    }
    // A message could disappear from `messages` for a reason other than
    // expiry (manual delete, chat switch) — clear its timer so it doesn't
    // fire a no-op removal later.
    for (const [id, timer] of scheduled) {
      if (!stillPresent.has(id)) { clearTimeout(timer); scheduled.delete(id); }
    }
  }, [messages]);

  useEffect(() => () => {
    for (const timer of disappearTimersRef.current.values()) clearTimeout(timer);
  }, []);

  // ─── Typing presence ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!user||!partnerId) return;
    const name = [user.id,partnerId].sort().join("-");
    const ch = supabase.channel(`typing-${name}`)
      .on("broadcast",{ event:"typing" },(payload) => {
        if (payload.payload?.user_id!==partnerId) return;
        setPartnerTyping(true);
        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = setTimeout(() => setPartnerTyping(false),2000);
      }).subscribe();
    presenceChannelRef.current = ch;
    return () => { supabase.removeChannel(ch); if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current); };
  }, [user,partnerId]);

  // ─── Online presence ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!user||!partnerId) return;
    const ch = supabase.channel(`presence-${[user.id,partnerId].sort().join("-")}`,{ config:{ presence:{ key:user.id } } })
      .on("presence",{ event:"sync" },() => { const s = ch.presenceState(); setPartnerOnline(!!s[partnerId]); })
      .on("presence",{ event:"join" },({ key }) => { if (key===partnerId) setPartnerOnline(true); })
      .on("presence",{ event:"leave" },({ key }) => { if (key===partnerId) setPartnerOnline(false); })
      .subscribe(async (status) => { if (status==="SUBSCRIBED") await ch.track({ online_at:new Date().toISOString() }); });
    return () => { supabase.removeChannel(ch); };
  }, [user,partnerId]);

  const broadcastTyping = useCallback(() => {
    if (!presenceChannelRef.current||!user) return;
    const now = Date.now();
    if (now-lastTypingRef.current<2000) return;
    lastTypingRef.current = now;
    presenceChannelRef.current.send({ type:"broadcast",event:"typing",payload:{ user_id:user.id } });
  }, [user]);

  // ─── Voice recording ──────────────────────────────────────────────────────
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio:true });
      const mr = new MediaRecorder(stream,{
        mimeType: MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4",
      });
      audioChunksRef.current = [];
      recordingCancelledRef.current = false;
      mr.ondataavailable = e => { if (e.data.size>0) audioChunksRef.current.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach(t=>t.stop());
        // FIX: check cancel flag before sending
        if (recordingCancelledRef.current) return;
        const blob = new Blob(audioChunksRef.current, { type:mr.mimeType });
        if (blob.size>0) await sendVoiceMessage(blob);
      };
      mediaRecorderRef.current = mr;
      mr.start(100);
      setIsRecording(true); setRecordingTime(0);
      recordingTimerRef.current = setInterval(() => setRecordingTime(t=>t+1),1000);
    } catch {
      toast({ title:"Microphone permission denied", variant:"destructive" });
    }
  };

  const stopRecording = () => {
    if (!isRecording) return;
    if (mediaRecorderRef.current?.state!=="inactive") mediaRecorderRef.current?.stop();
    setIsRecording(false);
    if (recordingTimerRef.current) { clearInterval(recordingTimerRef.current); recordingTimerRef.current=null; }
  };

  const cancelRecording = () => {
    // FIX: set cancel flag BEFORE calling stop so onstop skips sendVoiceMessage
    recordingCancelledRef.current = true;
    if (mediaRecorderRef.current?.state!=="inactive") {
      mediaRecorderRef.current?.stop();
      mediaRecorderRef.current?.stream.getTracks().forEach(t=>t.stop());
    }
    audioChunksRef.current = [];
    setIsRecording(false);
    if (recordingTimerRef.current) { clearInterval(recordingTimerRef.current); recordingTimerRef.current=null; }
  };

  const sendVoiceMessage = async (blob: Blob) => {
    if (!user||!partnerId) return;
    const ext = blob.type.includes("webm")?"webm":"m4a";
    const path = `${user.id}/${Date.now()}_voice.${ext}`;
    const { data: upData, error: upErr } = await supabase.storage.from("chat-files").upload(path,blob,{ contentType:blob.type });
    if (upErr||!upData) { toast({ title:"Upload failed", description:upErr?.message, variant:"destructive" }); return; }
    const { data: urlData } = supabase.storage.from("chat-files").getPublicUrl(path);
    const { error } = await supabase.from("messages").insert({
      sender_id:user.id, receiver_id:partnerId, content:"🎤 Voice message",
      message_type:"voice", file_url:urlData.publicUrl, file_name:`voice.${ext}`,
      disappear_at:disappearMode?"pending":null,
    });
    if (error) toast({ title:"Failed to send voice message", variant:"destructive" });
  };

  // ─── Send ─────────────────────────────────────────────────────────────────
  const handleSend = useCallback(async () => {
    // Edit mode: update message
    if (editingMsg) {
      if (!editText.trim()) return;
      const enc = e2eReady ? await encrypt(editText) : editText;
      const { error } = await supabase.from("messages")
        .update({ content:enc, edited_at:new Date().toISOString() } as any)
        .eq("id",editingMsg.id);
      if (error) toast({ title:"Failed to edit", variant:"destructive" });
      setEditingMsg(null); setEditText(""); setMessage("");
      return;
    }

    if (!message.trim()||!user||!partnerId) return;
    if (partnerId && !e2eReady) {
      toast({ title:"Securing connection…", description:"Please wait a moment." }); return;
    }
    // "/silent your text" sends normally but skips the push notification —
    // the recipient still sees it next time they open the app/chat.
    let text = message;
    let isSilent = false;
    const silentMatch = text.match(/^\/silent\s+([\s\S]+)/i);
    if (silentMatch) {
      isSilent = true;
      text = silentMatch[1];
    } else if (/^\/silent\s*$/i.test(text.trim())) {
      // "/silent" with nothing after it — nothing to actually send.
      return;
    }
    // FIX AUDIT #15: deduplicate sends — prevent double-send on rapid tap or reconnect
    const dedupKey = `${user.id}-${text.slice(0, 20)}-${Date.now()}`;
    if (!sendDedup.tryAcquire(dedupKey)) return;

    setMessage(""); const rep = replyTo; setReplyTo(null);
    const enc = e2eReady ? await encrypt(text) : text;
    hapticMessageSent();
    const loveEmojis = ["❤️","♥️","💕","💖","💗","😍","🥰","💘","💝","🔥","🎉"];
    for (const e of loveEmojis) { if (text.includes(e)) { dispatchEmojiEffect(e); break; } }
    try {
      const { error } = await supabase.from("messages").insert({
        sender_id:user.id, receiver_id:partnerId, content:enc, message_type:"text",
        reply_to_id:rep?.id||null, disappear_at:disappearMode?"pending":null,
        silent: isSilent,
      } as any);
      if (error) {
        logError("Chat.handleSend", "insert failed", error);
        toast({ title:"Failed to send", variant:"destructive" });
      }
    } finally {
      sendDedup.release(dedupKey);
    }
  }, [message,user,partnerId,encrypt,e2eReady,replyTo,disappearMode,toast,editingMsg,editText]);

  // ─── Nudge ────────────────────────────────────────────────────────────────
  const sendNudge = useCallback(async () => {
    if (!user||!partnerId) return;
    const now = Date.now();
    if (now - lastNudgeRef.current < 10_000) {
      toast({ title:"Wait a moment before nudging again 😅" }); return;
    }
    lastNudgeRef.current = now;
    hapticMedium();
    dispatchEmojiEffect("❤️");
    await supabase.from("messages").insert({
      sender_id:user.id, receiver_id:partnerId, content:"❤️",
      message_type:"nudge", disappear_at:null,
    });
  }, [user,partnerId,toast]);

  // ─── File upload ──────────────────────────────────────────────────────────
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>, type:"image"|"file") => {
    const file = e.target.files?.[0];
    if (!file||!user||!partnerId) return;
    // Fix #Bug10: validate file size before uploading — previously any size was accepted silently
    const MAX_MB = 50;
    if (file.size > MAX_MB * 1024 * 1024) {
      toast({ title:`File too large`, description:`Maximum size is ${MAX_MB}MB. Please choose a smaller file.`, variant:"destructive" });
      e.target.value = "";
      return;
    }
    setShowAttach(false);
    const path = `${user.id}/${Date.now()}_${file.name}`;
    const { data: upData, error: upErr } = await supabase.storage.from("chat-files").upload(path,file,{ contentType:file.type });
    if (upErr||!upData) { toast({ title:"Upload failed", description:upErr?.message, variant:"destructive" }); return; }
    const { data: urlData } = supabase.storage.from("chat-files").getPublicUrl(path);
    const { error } = await supabase.from("messages").insert({
      sender_id:user.id, receiver_id:partnerId,
      content: type==="image" ? "📷 Photo" : `📎 ${file.name}`,
      message_type:type, file_url:urlData.publicUrl, file_name:file.name,
      disappear_at:disappearMode?"pending":null,
    });
    if (error) toast({ title:"Failed to send file", variant:"destructive" });
    e.target.value = "";
  };

  // FIX: clearChat queries DB directly — not limited to loaded page
  const clearChat = async () => {
    if (!user||!partnerId) return;
    await supabase.from("messages")
      .update({ deleted_by_sender: true } as any)
      .eq("sender_id", user.id).eq("receiver_id", partnerId);
    await supabase.from("messages")
      .update({ deleted_by_receiver: true } as any)
      .eq("sender_id", partnerId).eq("receiver_id", user.id);
    setMessages([]); markedReadRef.current = new Set();
    setShowClearDialog(false);
    toast({ title:"Chat cleared", description:"Cleared for you only. Your partner can still see these messages." });
  };

  const recoverChat = async () => {
    if (!user||!partnerId) return;
    await supabase.from("messages").update({ deleted_by_sender:false } as any).eq("sender_id",user.id).eq("receiver_id",partnerId);
    await supabase.from("messages").update({ deleted_by_receiver:false } as any).eq("sender_id",partnerId).eq("receiver_id",user.id);
    markedReadRef.current = new Set();
    await fetchMessages();
    toast({ title:"Chat recovered! 💬" });
  };

  // ─── Pin message ──────────────────────────────────────────────────────────
  const handlePin = useCallback(async () => {
    if (!contextMenuMsg) return;
    const alreadyPinned = !!contextMenuMsg.is_pinned;
    await supabase.from("messages").update({ is_pinned: !alreadyPinned } as any).eq("id",contextMenuMsg.id);
    setContextMenuMsg(null);
    toast({ title: alreadyPinned ? "Unpinned" : "Message pinned 📌" });
  }, [contextMenuMsg, toast]);

  // ─── Edit message ─────────────────────────────────────────────────────────
  const handleStartEdit = useCallback(() => {
    if (!contextMenuMsg) return;
    setEditingMsg(contextMenuMsg);
    setEditText(contextMenuMsg.decryptedContent||"");
    setMessage(contextMenuMsg.decryptedContent||"");
    setTimeout(() => inputRef.current?.focus(), 100);
    setContextMenuMsg(null);
  }, [contextMenuMsg]);

  // ─── Context menu actions ─────────────────────────────────────────────────
  const handleCopyMessage = useCallback(() => {
    if (contextMenuMsg?.decryptedContent) {
      navigator.clipboard.writeText(contextMenuMsg.decryptedContent);
      toast({ title:"Copied" });
    }
    setContextMenuMsg(null);
  }, [contextMenuMsg,toast]);

  const handleDeleteMessage = useCallback(async () => {
    if (!contextMenuMsg || !user) return;
    // FIX BUG-07: Enforce ownership at the query level, not just the UI.
    // The UI passes isMine to MessageContextMenu to conditionally show Delete,
    // but contextMenuMsg state is set on any long-press. Without this eq() the
    // handler would delete any message ID it receives, including the partner's.
    // Adding eq("sender_id", user.id) means the DB will reject deletes on rows
    // the current user doesn't own (even if RLS is misconfigured).
    if (contextMenuMsg.sender_id !== user.id) {
      toast({ title:"You can only delete your own messages", variant:"destructive" });
      setContextMenuMsg(null);
      return;
    }
    await supabase.from("messages").delete().eq("id",contextMenuMsg.id).eq("sender_id",user.id);
    setMessages(prev => prev.filter(m => m.id!==contextMenuMsg.id));
    setContextMenuMsg(null); toast({ title:"Deleted" });
  }, [contextMenuMsg, user, toast]);

  // ─── Calling ─────────────────────────────────────────────────────────────
  const startCall = async (mode:"video"|"voice") => {
    if (!user||!partnerId) return;
    // BUG FIX: guard against a fast double-tap calling startCall twice
    // before the isStartingCall-driven `disabled` prop re-renders — this
    // was racing two joinCall() calls and causing Daily's "Duplicate
    // DailyIframe instances are not allowed" error.
    if (isStartingCall) return;
    // The call session is shared app-wide now (see CallContext), so a call
    // started from the Calls page stays alive if the person navigates back
    // to a chat — check for that too, not just this page's own
    // isStartingCall flag, otherwise tapping the call button here while
    // already on a call elsewhere would silently waste a room-creation
    // request that joinCall() then has to discard via its own re-entrancy
    // guard.
    if (callState === "joining" || callState === "joined") {
      toast({ title: "Already on a call", description: "End the current call before starting a new one." });
      return;
    }

    // FIX AUDIT #6: rate-limit room creation (max 2 per minute)
    if (!callRoomLimiter.allow()) {
      const wait = formatRetryDelay(callRoomLimiter.retryAfterMs());
      toast({ title: "Please wait", description: `You can start another call in ${wait}.`, variant: "destructive" });
      return;
    }

    setIsStartingCall(true);
    callCancelledRef.current = false;
    try {
      // Mic-only probe — Daily.co requests camera itself when joining,
      // and probing video here can race PeekGuard / cameraBus consumers.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      stream.getTracks().forEach(t=>t.stop());
      playCallSound();
      // BUG FIX (call latency): "create-and-token" does both Daily API
      // calls server-side in one edge-function invocation instead of two
      // fully sequential client round trips (create-room, then only after
      // that resolves, get-token) — see the edge function for details.
      const data = await invokeEdgeFunction<{ name: string; url: string; token: string }>("daily-call",
        { body:{ action:"create-and-token", roomName:`duo-${user.id.slice(0,8)}-${Date.now()}` } });

      if (callCancelledRef.current) {
        // Cancelled while the network setup above was in flight — don't
        // join a call the person already backed out of. Best-effort clean
        // up the room we just created rather than leaving it orphaned.
        invokeEdgeFunction("daily-call", { body:{ action:"delete-room", roomName:data.name } }).catch(() => {});
        setIsStartingCall(false);
        return;
      }
      // BUG FIX (call latency): kick off the call_history insert without
      // awaiting it — nothing about actually joining the Daily room
      // depends on this row existing yet, only endCall() (much later)
      // does — and only await the result after joinCall(), so its round
      // trip overlaps with the (much longer) WebRTC join instead of
      // sitting in front of it on the critical path.
      const insertPromise = supabase.from("call_history").insert({
        caller_id:user.id, receiver_id:partnerId, call_type:mode,
        call_direction:"outgoing", status:"in_progress",
        room_name:data.url, started_at:new Date().toISOString(),
      } as any).select().single();
      // CALL-02 FIX: pass videoOff=true for voice calls so camera never opens
      await joinCall(data.url, data.token, mode === "voice");
      const { data:callRecord } = await insertPromise;
      if (callRecord) setCurrentCallId((callRecord as any).id);
      toast({ title:mode==="video"?"Video call started 📹":"Voice call started 📞" });
    } catch (err: unknown) {
      toast({ title:"Call failed", description: extractErrorMessage(err), variant:"destructive" });
    }
    setIsStartingCall(false);
  };

  const handleAcceptIncoming = useCallback(async (roomUrl: string, callType: string) => {
    if (isStartingCall) return; // CALL-01 FIX: guard against double-accept
    // Same cross-page guard as startCall — the call session is shared
    // app-wide now, so this also protects against accepting an incoming
    // call while already on another one.
    if (callState === "joining" || callState === "joined") {
      toast({ title: "Already on a call", description: "End the current call before accepting a new one." });
      return;
    }
    setIsStartingCall(true);
    try {
      const tokenData = await invokeEdgeFunction<{ token: string }>("daily-call",
        { body:{ action:"get-token", roomName:roomUrl.split("/").pop() } });
      // CALL-02 FIX: use videoOff flag instead of toggleVideo() after join
      await joinCall(roomUrl, tokenData.token, callType === "voice");
      toast({ title:"Call connected 📞" });
    } catch (err: unknown) { toast({ title:"Couldn't join call", description: extractErrorMessage(err), variant:"destructive" }); }
    setIsStartingCall(false);
  }, [joinCall, isStartingCall, callState, toast]);

  const handleDeclineIncoming = useCallback((_id: string) => { toast({ title:"Call declined" }); }, [toast]);

  const endCall = async () => {
    if (currentCallId && user) {
      await supabase.from("call_history").update({
        status:"completed", duration_seconds:callDuration, ended_at:new Date().toISOString(),
      } as any).eq("id",currentCallId);
      setCurrentCallId(null);
    }
    leaveCall();
  };

  // BUG FIX (call latency): cancel a call that's still in the pre-join
  // network setup phase (create-and-token / call_history insert), reachable
  // now that the call screen — and its hang-up button — shows up the
  // instant the call button is tapped instead of only once actually
  // joined. Sets callCancelledRef so startCall()'s in-flight work bails
  // out instead of joining a call the person already backed out of.
  const cancelStartingCall = () => {
    callCancelledRef.current = true;
    leaveCall(); // safe no-op if joinCall() hasn't created a call object yet
    setIsStartingCall(false);
    toast({ title:"Call cancelled" });
  };

  // ─── Search ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!searchQuery.trim()) { setSearchResults([]); setSearchIndex(0); return; }
    const q = searchQuery.toLowerCase();
    const results = messages
      .filter(m => (m.decryptedContent&&m.decryptedContent.toLowerCase().includes(q))||(m.file_name&&m.file_name.toLowerCase().includes(q)))
      .map(m=>m.id);
    setSearchResults(results);
    setSearchIndex(results.length>0 ? results.length-1 : 0);
  }, [searchQuery,messages]);

  useEffect(() => {
    if (!searchResults.length) return;
    document.getElementById(`msg-${searchResults[searchIndex]}`)?.scrollIntoView({ behavior:"smooth", block:"center" });
  }, [searchIndex,searchResults]);

  const formatTime = (iso: string) => new Date(iso).toLocaleTimeString([],{ hour:"2-digit", minute:"2-digit" });
  const formatRecTime = (s: number) => `${Math.floor(s/60)}:${(s%60).toString().padStart(2,"0")}`;

  // ─── Timeline ─────────────────────────────────────────────────────────────
  const timeline: TimelineItem[] = [
    ...messages.map(m=>({ type:"message" as const, data:m })),
    ...callHistory.map(c=>({ type:"call" as const, data:c })),
    // WA-01 FIX: merge imported WhatsApp messages into the timeline,
    // sorted by their original_timestamp so they appear at the correct
    // historical position relative to real messages.
    ...importedMessages.map(i=>({ type:"imported" as const, data:i })),
  ].sort((a, b) => {
    const tsA = a.type === "imported"
      ? new Date((a.data as ImportedMessage).original_timestamp).getTime()
      : new Date(a.data.created_at).getTime();
    const tsB = b.type === "imported"
      ? new Date((b.data as ImportedMessage).original_timestamp).getTime()
      : new Date(b.data.created_at).getTime();
    const diff = tsA - tsB;
    if (diff !== 0) return diff;
    // BUG-15 stable sort, refined: same original_timestamp (common for
    // WhatsApp imports, which only carry minute-level precision) used to
    // fall back to comparing `id` — a random UUID with zero relationship
    // to actual send order, so same-minute bursts could render shuffled.
    // Falling back to each row's own `created_at` (DB insertion order)
    // instead approximates the real order much better, since import
    // batches are inserted sequentially. New imports no longer produce
    // exact ties at all (see the timestamp-nudge fix in runWhatsAppImport),
    // so this path now mainly protects chats imported before that fix.
    const insA = new Date(a.data.created_at).getTime();
    const insB = new Date(b.data.created_at).getTime();
    return insA !== insB ? insA - insB : a.data.id.localeCompare(b.data.id);
  });

  const groupedTimeline: { date:string; items:TimelineItem[] }[] = [];
  timeline.forEach(item => {
    // WA-01 FIX: use original_timestamp for imported items so date headers
    // reflect the historical date, not the import date
    const rawDate = item.type === "imported"
      ? (item.data as ImportedMessage).original_timestamp
      : item.data.created_at;
    const date = new Date(rawDate).toLocaleDateString(undefined,{ weekday:"short", month:"short", day:"numeric", year:"numeric" });
    const last = groupedTimeline[groupedTimeline.length-1];
    if (last?.date===date) last.items.push(item);
    else groupedTimeline.push({ date, items:[item] });
  });

  // ─── In-call overlay ──────────────────────────────────────────────────────
  // FIX: handle callState === "error"
  if (callState==="error") {
    return (
      <motion.div initial={{ opacity:0 }} animate={{ opacity:1 }}
        className="fixed inset-0 z-[100] flex flex-col h-[100dvh] bg-destructive/10 items-center justify-center gap-4 px-6">
        <div className="text-center space-y-2">
          <PhoneOff className="h-12 w-12 text-destructive mx-auto" />
          <p className="text-base font-semibold text-foreground">Call failed</p>
          {callError && <p className="text-sm text-muted-foreground">{callError}</p>}
        </div>
        <button onClick={() => { hapticMedium(); leaveCall(); }}
          className="h-11 px-6 rounded-full bg-primary text-primary-foreground text-sm font-medium">
          Back to chat
        </button>
      </motion.div>
    );
  }

  // BUG FIX (call latency): this used to gate on callState alone, which
  // only becomes "joining" deep inside joinCall() — itself called only
  // after the create-and-token network call and the call_history insert
  // both complete. The button just showed a "Starting..." label for that
  // entire stretch with no other feedback. Including isStartingCall here
  // means this whole screen (with its own "Connecting..." state below)
  // appears the instant the button is tapped, and the actual network
  // setup happens behind it instead of in front of it.
  if (isStartingCall || callState==="joined" || callState==="joining") {
    return (
      <motion.div initial={{ opacity:0 }} animate={{ opacity:1 }}
        className="fixed inset-0 z-[100] flex flex-col h-[100dvh] bg-[hsl(var(--foreground))] relative">
        <video ref={remoteVideoRef} autoPlay playsInline
          className={`absolute inset-0 w-full h-full object-cover ${isScreenSharing?"hidden":""}`} />
        <video ref={screenShareRef} autoPlay playsInline
          className="absolute inset-0 w-full h-full object-contain bg-black" style={{ display:"none" }} />
        {participantCount<=1 && callState==="joined" && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center text-background">
              <motion.div animate={{ scale:[1,1.05,1] }} transition={{ repeat:Infinity, duration:2 }}
                className="h-24 w-24 rounded-full bg-background/10 flex items-center justify-center mx-auto mb-5">
                {partnerAvatar ? <img src={partnerAvatar} alt="" className="h-full w-full rounded-full object-cover" /> : <Phone className="h-10 w-10 text-background/60" />}
              </motion.div>
              <p className="text-xl font-medium">{partnerName}</p>
              <p className="text-sm text-background/40 mt-1">Ringing...</p>
            </div>
          </div>
        )}
        {(isStartingCall || callState==="joining") && callState!=="joined" && (
          <div className="absolute inset-0 flex items-center justify-center bg-[hsl(var(--foreground))]">
            <p className="text-lg font-medium animate-pulse text-background/60">Connecting...</p>
          </div>
        )}
        <motion.div drag dragMomentum={false} dragElastic={0.1}
          className="absolute top-14 right-4 w-[100px] h-[140px] rounded-2xl overflow-hidden shadow-2xl border border-background/10 z-10 cursor-grab active:cursor-grabbing">
          <video ref={localVideoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
          {!isVideoOn && <div className="absolute inset-0 bg-muted flex items-center justify-center"><VideoOff className="h-5 w-5 text-muted-foreground" /></div>}
        </motion.div>
        <div className="absolute top-4 left-4 right-28 z-10 flex items-center gap-2 safe-top">
          <div className="bg-background/15 backdrop-blur-md rounded-full px-3 py-1.5 flex items-center gap-1.5">
            <div className={`h-1.5 w-1.5 rounded-full ${callNetworkQuality==="excellent"||callNetworkQuality==="good"?"bg-success":callNetworkQuality==="fair"?"bg-warning":"bg-destructive"}`} />
            <span className="text-[11px] text-background/80 font-mono">{formatCallDuration(callDuration)}</span>
          </div>
          {isScreenSharing && <div className="bg-primary/60 backdrop-blur-md rounded-full px-3 py-1.5 flex items-center gap-1"><Monitor className="h-3 w-3 text-background" /><span className="text-[10px] text-background">Sharing</span></div>}
          <button onClick={() => { hapticLight(); setShowLipReading(v=>!v); }}
            aria-label={showLipReading ? "Disable lip reading" : "Enable lip reading"}
            aria-pressed={showLipReading}
            className={`ml-auto rounded-full px-3 py-1.5 flex items-center gap-1.5 backdrop-blur-md transition-colors ${showLipReading?"bg-success/85":"bg-background/15"}`}>
            <Captions className="h-3.5 w-3.5 text-background" aria-hidden="true" />
            <span className="text-[10px] text-background font-medium">{showLipReading?"Reading":"Lip Read"}</span>
          </button>
        </div>
        <AnimatePresence>
          {showLipReading && callState==="joined" && <LipReadingOverlay videoRef={remoteVideoRef} onClose={() => setShowLipReading(false)} />}
        </AnimatePresence>
        <div className="absolute bottom-10 left-0 right-0 z-10 safe-bottom" role="toolbar" aria-label="Call controls">
          <div className="flex items-center justify-center gap-4">
            <button onClick={() => { hapticMedium(); toggleAudio(); }}
              aria-label={isAudioOn ? "Mute microphone" : "Unmute microphone"}
              aria-pressed={!isAudioOn}
              className={`h-12 w-12 rounded-full flex items-center justify-center transition-colors ${isAudioOn?"bg-background/15 backdrop-blur-md":"bg-destructive"}`}>
              {isAudioOn?<Mic className="h-5 w-5 text-background" aria-hidden="true" />:<MicOff className="h-5 w-5 text-background" aria-hidden="true" />}
            </button>
            <button onClick={() => { hapticMedium(); toggleVideo(); }}
              aria-label={isVideoOn ? "Turn off camera" : "Turn on camera"}
              aria-pressed={!isVideoOn}
              className={`h-12 w-12 rounded-full flex items-center justify-center transition-colors ${isVideoOn?"bg-background/15 backdrop-blur-md":"bg-destructive"}`}>
              {isVideoOn?<Video className="h-5 w-5 text-background" aria-hidden="true" />:<VideoOff className="h-5 w-5 text-background" aria-hidden="true" />}
            </button>
            <button onClick={() => { hapticMedium(); toggleScreenShare(); }}
              aria-label={isScreenSharing ? "Stop screen share" : "Start screen share"}
              aria-pressed={isScreenSharing}
              className={`h-12 w-12 rounded-full flex items-center justify-center transition-colors ${isScreenSharing?"bg-primary":"bg-background/15 backdrop-blur-md"}`}>
              {isScreenSharing?<MonitorOff className="h-5 w-5 text-background" aria-hidden="true" />:<Monitor className="h-5 w-5 text-background" aria-hidden="true" />}
            </button>
            <button onClick={() => { hapticMedium(); callState==="idle" ? cancelStartingCall() : endCall(); }}
              aria-label="End call"
              className="h-14 w-14 rounded-full bg-destructive flex items-center justify-center shadow-lg">
              <PhoneOff className="h-6 w-6 text-background" aria-hidden="true" />
            </button>
          </div>
        </div>
      </motion.div>
    );
  }

  const rootWallpaperCss = chatWallpaper ? resolveWallpaperStyle(chatWallpaper, colorMode) : null;
  const rootBackgroundStyle = rootWallpaperCss
    ? {
        background: disappearMode
          ? `linear-gradient(rgba(0,0,0,0.25), rgba(0,0,0,0.25)), ${rootWallpaperCss}`
          : rootWallpaperCss,
      }
    : undefined;

  // FIX: was h-[100dvh] (a hard, device-height value). Chat renders inside
  // AppLayout's <main>, which is already sized correctly (100dvh minus the
  // offline banner) and reserves room for the floating dock via
  // padding-bottom. Forcing 100dvh here made this box taller than the
  // space its flex parent actually gave it, so the composer got pushed
  // past the parent's clipped edge — visible as dead white space below
  // the chat box, and inconsistent across devices with different safe
  // areas ("not according to screen ratio"). h-full fills exactly what
  // the parent already computed.
  return (
    <div className="flex flex-col h-full bg-background overflow-hidden" style={rootBackgroundStyle}>
      <ChatSurpriseHost />
      <IncomingCallOverlay onAccept={handleAcceptIncoming} onDecline={handleDeclineIncoming} />

      {/* Nudge flash overlay */}
      <AnimatePresence>
        {nudgeFlash && (
          <motion.div initial={{ opacity:0 }} animate={{ opacity:1 }} exit={{ opacity:0 }}
            className="fixed inset-0 z-[200] flex items-center justify-center pointer-events-none">
            <motion.span animate={{ scale:[0.5,1.4,1] }} transition={{ duration:0.5 }} className="text-8xl">❤️</motion.span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header */}
      <header className="safe-top px-4 pt-3 pb-2.5 bg-background/90 backdrop-blur-md border-b border-border/25 sticky top-0 z-20">
        <div className="flex items-center justify-between gap-2">
          <motion.button
            whileTap={{ scale: 0.97 }}
            onClick={() => { hapticLight(); navigate("/profile"); }}
            onPointerDown={() => routePreload["/profile"]?.().catch(() => {})}
            className="flex items-center gap-2.5 min-w-0 -ml-1 pl-1 pr-1.5 py-1 rounded-xl active:bg-muted/40 transition-colors"
            aria-label="Open profile"
          >
            <div className="h-9 w-9 rounded-full bg-muted flex items-center justify-center overflow-hidden shrink-0">
              {partnerAvatar ? (
                <img src={partnerAvatar} alt="" className="h-full w-full object-cover" />
              ) : appIcon ? (
                <img src={appIcon} alt={appName} className="h-full w-full object-cover" />
              ) : (
                <span className="text-[10px] font-semibold text-muted-foreground">{appName.slice(0,2).toUpperCase()}</span>
              )}
            </div>
            <div className="min-w-0 text-left">
              <h1 className="text-sm font-semibold text-foreground leading-tight flex items-center gap-1.5">
                <span className="truncate">{partnerId ? partnerName : appName}</span>
                {disappearMode && (
                  <span title={`Disappearing messages: ${DISAPPEAR_OPTIONS.find(o=>o.value===disappearMs)?.label ?? ""}`}
                    className="inline-flex items-center gap-0.5 bg-primary/15 text-primary text-[9px] font-semibold px-1.5 py-0.5 rounded-full shrink-0">
                    <Timer className="h-2.5 w-2.5" /> ON
                  </span>
                )}
              </h1>
              <p className="text-[11px] text-muted-foreground leading-tight truncate">
                {partnerTyping?"typing...":partnerOnline?"🟢 online":e2eReady?"end-to-end encrypted":partnerId?"securing…":"Link a partner in settings"}
              </p>
            </div>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" aria-hidden="true" />
          </motion.button>
          <div className="flex items-center gap-1">
            <button onClick={() => { hapticMedium(); startCall("video"); }} disabled={isStartingCall||!partnerId}
              aria-label="Start video call"
              className="h-9 w-9 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-30">
              <Video className="h-[18px] w-[18px]" aria-hidden="true" />
            </button>
            <button onClick={() => { hapticMedium(); startCall("voice"); }} disabled={isStartingCall||!partnerId}
              aria-label="Start voice call"
              className="h-9 w-9 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-30">
              <Phone className="h-[17px] w-[17px]" aria-hidden="true" />
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button aria-label="More chat options" className="h-9 w-9 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors">
                  <MoreVertical className="h-[18px] w-[18px]" aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48 rounded-xl border-border/50">
                {partnerId && (
                  <DropdownMenuItem onClick={() => { hapticMedium(); sendNudge(); }}>
                    <Heart className="h-4 w-4 mr-2.5" /> Send nudge
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => { hapticLight(); setSearchOpen(!searchOpen); setSearchQuery(""); if(!searchOpen) setTimeout(()=>searchInputRef.current?.focus(),100); }}>
                  <Search className="h-4 w-4 mr-2.5" /> Search
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => { hapticLight(); disappearMode ? setDisappearMode(false) : setShowDisappearSheet(true); }}>
                  {disappearMode ? <Timer className="h-4 w-4 mr-2.5" /> : <TimerOff className="h-4 w-4 mr-2.5" />}
                  {disappearMode ? "Disable disappearing" : "Disappearing messages"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => { hapticLight(); navigate("/settings"); }}>Settings</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => { hapticMedium(); recoverChat(); }}>
                  <Reply className="h-4 w-4 mr-2.5" /> Recover chat
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => { hapticWarning(); setShowClearDialog(true); }} className="text-destructive focus:text-destructive">
                  <Trash2 className="h-4 w-4 mr-2.5" /> Clear chat
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Search bar */}
        <AnimatePresence>
          {searchOpen && (
            <motion.div initial={{ height:0,opacity:0 }} animate={{ height:"auto",opacity:1 }} exit={{ height:0,opacity:0 }} transition={{ duration:0.15 }} className="overflow-hidden">
              <div className="flex items-center gap-2 mt-2 bg-muted/40 rounded-full px-3 py-1.5">
                <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <input ref={searchInputRef} type="text" value={searchQuery} onChange={e=>setSearchQuery(e.target.value)}
                  placeholder="Search loaded messages..." className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
                {searchResults.length>0 && (
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] text-muted-foreground whitespace-nowrap">{searchIndex+1}/{searchResults.length}</span>
                    <button onClick={() => { hapticTick(); setSearchIndex(i=>Math.max(0,i-1)); }} aria-label="Previous match" className="h-6 w-6 flex items-center justify-center text-muted-foreground"><ChevronUp className="h-3.5 w-3.5" aria-hidden="true" /></button>
                    <button onClick={() => { hapticTick(); setSearchIndex(i=>Math.min(searchResults.length-1,i+1)); }} aria-label="Next match" className="h-6 w-6 flex items-center justify-center text-muted-foreground"><ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /></button>
                  </div>
                )}
                <button onClick={() => { hapticLight(); setSearchOpen(false); setSearchQuery(""); }} aria-label="Close search" className="h-6 w-6 flex items-center justify-center text-muted-foreground"><X className="h-3.5 w-3.5" aria-hidden="true" /></button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </header>

      {/* Pinned message banner */}
      <AnimatePresence>
        {pinnedMsg && (
          <PinnedMessageBanner msg={pinnedMsg} onJump={() => document.getElementById(`msg-${pinnedMsg.id}`)?.scrollIntoView({ behavior:"smooth", block:"center" })} />
        )}
      </AnimatePresence>

      {/* Disappear mode banner */}
      <AnimatePresence>
        {disappearMode && (
          <motion.div initial={{ height:0,opacity:0 }} animate={{ height:"auto",opacity:1 }} exit={{ height:0,opacity:0 }} className="overflow-hidden">
            <div className="px-4 py-1.5 bg-primary/5 flex items-center justify-center gap-1.5">
              <Timer className="h-3 w-3 text-primary animate-pulse-soft" />
              <span className="text-[10px] text-primary font-medium">
                Disappear after {DISAPPEAR_OPTIONS.find(o=>o.value===disappearMs)?.label||"30 seconds"} • Tap timer to change
              </span>
              <button onClick={() => { hapticLight(); setShowDisappearSheet(true); }} className="ml-1 text-[10px] text-primary underline">change</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Messages */}
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
                  return <CallEvent key={`call-${c.id}`} callType={c.call_type} status={c.status} direction={c.call_direction} durationSeconds={c.duration_seconds} createdAt={c.created_at} isMine={c.caller_id===user?.id} />;
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
                  return (
                    <div key={`imp-${imp.id}`} className={`flex px-3 py-0.5 ${imp.is_self ? "justify-end" : "justify-start"}`}>
                      <div className={`max-w-[75%] bg-muted/40 border border-border/40 rounded-2xl px-3 py-2 space-y-0.5 ${imp.is_self ? "rounded-tr-sm" : "rounded-tl-sm"}`}>
                        <p className="text-[10px] font-semibold text-primary/70">{label}</p>
                        <p className="text-sm text-foreground/80 whitespace-pre-wrap break-words">{imp.content}</p>
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
                  <MessageBubble key={msg.id} msg={msg} isMine={msg.sender_id===user?.id}
                    isDisappearing={!!msg.disappear_at&&msg.disappear_at!=="pending"}
                    isHighlighted={searchResults.includes(msg.id)} isActiveResult={searchResults[searchIndex]===msg.id}
                    repliedMsg={repliedMsg} partnerName={partnerName} userId={user?.id||""}
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
        {!messagesLoading && !messagesError && messages.length===0 && (
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

      {/* Attach menu */}
      <AnimatePresence>
        {showAttach && !isRecording && (
          <motion.div initial={{ opacity:0,y:8,scale:0.98 }} animate={{ opacity:1,y:0,scale:1 }} exit={{ opacity:0,y:8,scale:0.98 }}
            transition={{ type: "spring", stiffness: 380, damping: 28 }}
            className="mx-4 mb-2 bg-card/90 backdrop-blur-md border border-border/20 rounded-2xl p-3 flex gap-3">
            {[
              { label: "Photo",  icon: ImageIcon, onClick: async () => { if (await ensureMedia("photos", () => imageInputRef.current?.click())) imageInputRef.current?.click(); } },
              { label: "Camera", icon: Camera,    onClick: async () => { if (await ensureMedia("camera", () => cameraInputRef.current?.click())) cameraInputRef.current?.click(); } },
              { label: "File",   icon: FileText,  onClick: async () => { if (await ensureMedia("files", () => fileInputRef.current?.click())) fileInputRef.current?.click(); } },
            ].map(({ label, icon: Icon, onClick }) => (
              <button key={label} onClick={() => { hapticLight(); onClick(); }} className="flex flex-col items-center gap-1.5 flex-1 active:scale-95 transition-transform group">
                <span className="h-11 w-11 rounded-full flex items-center justify-center bg-muted group-hover:bg-accent/15 transition-colors">
                  <Icon className="h-5 w-5 text-foreground/70 group-hover:text-accent transition-colors" />
                </span>
                <span className="text-[11px] text-muted-foreground">{label}</span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Reply preview */}
      <AnimatePresence>
        {replyTo && (
          <ReplyPreview replyToContent={replyTo.decryptedContent||"Message"}
            replyToSenderName={replyTo.sender_id===user?.id?"You":partnerName} onCancel={() => setReplyTo(null)} />
        )}
      </AnimatePresence>

      {/* Edit banner */}
      <AnimatePresence>
        {editingMsg && (
          <motion.div initial={{ height:0,opacity:0 }} animate={{ height:"auto",opacity:1 }} exit={{ height:0,opacity:0 }}
            className="px-4 py-2 bg-info/10 border-t border-info/20 flex items-center gap-2">
            <Pencil className="h-3.5 w-3.5 text-info shrink-0" />
            <span className="text-[11px] text-info flex-1 truncate">Editing message</span>
            <button onClick={() => { hapticLight(); setEditingMsg(null); setEditText(""); setMessage(""); }} aria-label="Cancel edit">
              <X className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Input area */}
      {/* BUG FIX: this had no z-index, so DisappearGestureHandle's full-viewport
          dim overlay (fixed inset-0 z-30, up to ~55-60% black) rendered visually
          on top of it whenever Vanish Mode is on or mid-drag — the whole compose
          bar (message box, attach, mic) looked covered by a black box. The dim
          is meant to darken the chat above, not the input controls themselves. */}
      <div className="relative z-40 px-3 pb-3 pt-1.5 safe-bottom bg-background/90 backdrop-blur-md border-t border-border/25 shrink-0">
        <div className="flex justify-center">
          <DisappearGestureHandle
            steps={DISAPPEAR_OPTIONS}
            active={disappearMode}
            currentMs={disappearMs}
            onOpenPicker={() => setShowDisappearSheet(true)}
            onCommit={(ms) => {
              if (ms === 0) { setDisappearMode(false); }
              else { setDisappearMs(ms); setDisappearMode(true); }
            }}
          />
        </div>
        {isRecording ? (
          <motion.div initial={{ opacity:0,scale:0.97 }} animate={{ opacity:1,scale:1 }}
            className="flex items-center gap-3 bg-destructive/5 rounded-full border border-destructive/10 px-4 py-2.5">
            <div className="flex items-end gap-0.5 h-4 shrink-0" aria-hidden="true">
              {[0,1,2,3].map(i => (
                <motion.span key={i}
                  className="w-[3px] rounded-full bg-destructive inline-block"
                  animate={{ height: ["6px", "16px", "6px"] }}
                  transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.15, ease: "easeInOut" }}
                />
              ))}
            </div>
            <span className="text-sm font-medium text-destructive flex-1">{formatRecTime(recordingTime)}</span>
            <button onClick={() => { hapticWarning(); cancelRecording(); }} aria-label="Cancel voice recording" className="h-8 w-8 rounded-full bg-muted flex items-center justify-center"><Trash2 className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" /></button>
            <button onClick={() => { hapticSend(); stopRecording(); }} aria-label="Send voice recording" className="h-8 w-8 rounded-full bg-primary flex items-center justify-center"><Send className="h-3.5 w-3.5 text-primary-foreground" aria-hidden="true" /></button>
          </motion.div>
        ) : (
          <div className="flex items-center gap-1.5">
            <div className="flex-1 flex items-center gap-1 bg-muted/40 backdrop-blur-md rounded-full border border-border/20 px-2 py-1">
              <button onClick={() => { hapticLight(); setShowAttach(!showAttach); }}
                aria-label="Attachments"
                aria-expanded={showAttach}
                className="h-8 w-8 rounded-full flex items-center justify-center shrink-0 text-muted-foreground hover:text-foreground transition-colors">
                <Paperclip className="h-4 w-4" aria-hidden="true" />
              </button>
              <input ref={inputRef} type="text" value={message}
                aria-label="Message"
                onChange={e => { setMessage(e.target.value); broadcastTyping(); if(editingMsg) setEditText(e.target.value); }}
                onKeyDown={e => e.key==="Enter" && handleSend()}
                placeholder={editingMsg?"Edit message...":replyTo?"Reply...":"Message · /silent for no notification"}
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60 py-1.5" />
              {/^\/silent(\s|$)/i.test(message) && (
                <span className="text-[10px] text-muted-foreground/70 shrink-0 pr-1 flex items-center gap-0.5">
                  <BellOff className="h-3 w-3" aria-hidden="true" /> silent
                </span>
              )}
            </div>
            {message.trim() ? (
              <motion.button initial={{ scale:0 }} animate={{ scale:1 }} onClick={() => { handleSend(); }}
                aria-label={editingMsg ? "Save edit" : "Send message"}
                className="h-10 w-10 rounded-full bg-primary flex items-center justify-center shrink-0">
                {editingMsg ? <Check className="h-4 w-4 text-primary-foreground" aria-hidden="true" /> : <Send className="h-4 w-4 text-primary-foreground" aria-hidden="true" />}
              </motion.button>
            ) : (
              <button
                onPointerDown={(e) => {
                  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                  startRecording();
                }}
                onPointerUp={stopRecording}
                aria-label="Hold to record voice message"
                // Fix #Bug4: pointer events unify touch+mouse — no double-fire on Android/iOS.
                // onMouseDown/onTouchStart both fired on mobile causing startRecording() twice.
                // BUG FIX: onPointerLeave used to cancel the recording, but without
                // setPointerCapture, natural finger drift off this small button during
                // a hold gesture fired pointerleave almost instantly — every recording
                // attempt got silently cancelled before release. Pointer capture routes
                // move/up events to this element regardless of drift; pointercancel
                // (a real interruption — e.g. an incoming call) is the correct signal
                // to cancel, not the finger simply wandering off the button's bounds.
                onPointerCancel={() => { if (isRecording) cancelRecording(); }}
                style={{ touchAction: "none" }}
                className="h-10 w-10 rounded-full bg-primary flex items-center justify-center shrink-0 active:scale-95 transition-transform">
                <Mic className="h-4 w-4 text-primary-foreground" aria-hidden="true" />
              </button>
            )}
            <HubButton onClick={() => { hapticMedium(); setShowGridMenu(!showGridMenu); }} isOpen={showGridMenu}
              onLongPress={message.trim() ? () => { setShowGridMenu(false); setShowSchedulePicker(true); } : undefined} />
          </div>
        )}
      </div>

      {/* Hidden inputs */}
      <input ref={imageInputRef} type="file" accept="image/*,video/*" className="hidden" onChange={e=>handleFileSelect(e,"image")} />
      <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={e=>handleFileSelect(e,"image")} />
      <input ref={fileInputRef} type="file" className="hidden" onChange={e=>handleFileSelect(e,"file")} />
      {permissionSheet}

      {/* Disappearing timer sheet */}
      <Sheet open={showDisappearSheet} onOpenChange={setShowDisappearSheet}>
        <SheetContent side="bottom" className="rounded-t-2xl pb-safe">
          <SheetHeader className="mb-4"><SheetTitle className="text-base">Disappearing messages</SheetTitle></SheetHeader>
          <div className="space-y-2">
            {DISAPPEAR_OPTIONS.map(opt => (
              <button key={opt.value} onClick={() => { hapticSelection(); setDisappearMs(opt.value); setDisappearMode(true); setShowDisappearSheet(false); }}
                className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-colors ${
                  disappearMode && disappearMs===opt.value ? "bg-primary/10 border-primary/30" : "bg-card border-border/50"
                }`}>
                <span className="text-sm">{opt.label}</span>
                {disappearMode && disappearMs===opt.value && <Check className="h-4 w-4 text-primary" />}
              </button>
            ))}
            <button onClick={() => { hapticLight(); setDisappearMode(false); setShowDisappearSheet(false); }}
              className="w-full flex items-center justify-between px-4 py-3 rounded-xl border border-border/50 bg-card transition-colors">
              <span className="text-sm text-muted-foreground">Off</span>
              {!disappearMode && <Check className="h-4 w-4 text-primary" />}
            </button>
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={showClearDialog} onOpenChange={setShowClearDialog}>
        <AlertDialogContent className="rounded-2xl max-w-[320px]">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm font-semibold">Clear chat?</AlertDialogTitle>
            <AlertDialogDescription className="text-xs">Messages will be hidden for you. Your partner can still see and recover them.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-full text-xs h-8">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { hapticError(); clearChat(); }} className="rounded-full bg-destructive text-destructive-foreground text-xs h-8">Clear</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Overlays */}
      <AnimatePresence>{showGridMenu && <GridMenu onClose={() => setShowGridMenu(false)} onScheduledMessage={message.trim() ? () => setShowSchedulePicker(true) : undefined} onLoveLetter={() => setShowLoveLetter(true)} />}</AnimatePresence>
      <AnimatePresence>{viewingPhoto && <PhotoViewer src={viewingPhoto} onClose={() => setViewingPhoto(null)} />}</AnimatePresence>
      <AnimatePresence>
        {showSchedulePicker && message.trim() && (
          <div className="relative">
            <ScheduledMessagePicker message={message} onSchedule={handleScheduleMessage} onClose={() => setShowSchedulePicker(false)} />
          </div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {showLoveLetter && <LoveLetter partnerName={partnerName||"Partner"} onSend={handleSendLoveLetter} onClose={() => setShowLoveLetter(false)} />}
      </AnimatePresence>
      <MessageContextMenu
        isOpen={!!contextMenuMsg}
        onClose={() => setContextMenuMsg(null)}
        onCopy={handleCopyMessage}
        onDelete={handleDeleteMessage}
        onReply={() => { if(contextMenuMsg){setReplyTo(contextMenuMsg);inputRef.current?.focus();} setContextMenuMsg(null); }}
        onReact={() => { if(contextMenuMsg) setReactingMsgId(contextMenuMsg.id); setContextMenuMsg(null); }}
        onEdit={handleStartEdit}
        onPin={handlePin}
        isMine={contextMenuMsg?.sender_id===user?.id}
        isPinned={!!contextMenuMsg?.is_pinned}
        messageContent={contextMenuMsg?.decryptedContent||null}
        messageType={contextMenuMsg?.message_type}
      />
    </div>
  );
};

export default Chat;

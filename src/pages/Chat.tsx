import { motion, AnimatePresence } from "framer-motion";
import {
  Send, Paperclip, ImageIcon, FileText, Trash2, Camera, Mic, Play, Pause,
  Reply, Timer, TimerOff, Search, X, ChevronUp, ChevronDown, Phone, Video,
  MoreVertical, MicOff, VideoOff, PhoneOff, Monitor, MonitorOff, Captions,
  Heart, Pin, Pencil, Check, WifiOff,
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
import ScheduledMessagePicker from "@/components/chat/ScheduledMessagePicker";
import LoveLetter from "@/components/chat/LoveLetter";
import LipReadingOverlay from "@/components/LipReadingOverlay";
import { useState, useRef, useEffect, useCallback } from "react";
import { useLongPress } from "@/hooks/useLongPress";
import { useNavigate } from "react-router-dom";
import { useTheme } from "@/contexts/ThemeContext";
import { supabase } from "@/integrations/supabase/client";
import { playMessageSound, playCallSound } from "@/lib/sounds";
import { hapticMedium, hapticMessageSent, hapticMessageReceived } from "@/lib/haptics";
import { useAuth } from "@/hooks/useAuth";
import { useE2E } from "@/hooks/useE2E";
import storage from "@/lib/storage";
import { useDailyCall } from "@/hooks/useDailyCall";
import { useToast } from "@/hooks/use-toast";
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
      <button onClick={toggle} className="h-9 w-9 rounded-full bg-accent/60 flex items-center justify-center shrink-0 transition-colors hover:bg-accent active:scale-95">
        {playing ? <Pause className="h-4 w-4 text-foreground" /> : <Play className="h-4 w-4 text-foreground ml-0.5" />}
      </button>
      <div className="flex-1 space-y-1">
        <div className="flex items-end gap-[2px] h-5 cursor-pointer" onClick={seekTo}>
          {waveform.map((h,i) => (
            <div key={i} className={`flex-1 rounded-full transition-all duration-75 ${
              duration && (i/waveform.length)<=(progress/duration)
                ? (isMine?"bg-background/60":"bg-foreground/60")
                : (isMine?"bg-background/20":"bg-foreground/20")
            }`} style={{ height:`${Math.max(15,h*100)}%` }} />
          ))}
        </div>
        <p className="text-[10px] text-muted-foreground">{fmt(progress>0?progress:duration)}</p>
      </div>
    </div>
  );
};

// ─── PinnedMessageBanner ──────────────────────────────────────────────────────
const PinnedMessageBanner = ({ msg, onJump }: { msg: DecryptedMessage; onJump: () => void }) => (
  <motion.button
    initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
    exit={{ height: 0, opacity: 0 }}
    onClick={onJump}
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
  onReply, onLongPress, onPhotoView, formatTime,
  allReactions, mediaVisible,
}: {
  msg: DecryptedMessage; isMine: boolean; isDisappearing: boolean;
  isHighlighted: boolean; isActiveResult: boolean;
  repliedMsg: DecryptedMessage | null; partnerName: string; userId: string;
  onReply: () => void; onLongPress: () => void;
  onPhotoView: (url: string) => void; formatTime: (iso: string) => string;
  allReactions?: { id: string; message_id: string; user_id: string; emoji: string; created_at: string }[]; mediaVisible?: boolean;
}) => {
  const lph = useLongPress(onLongPress, 500);
  return (
    <motion.div id={`msg-${msg.id}`}
      initial={{ opacity: 0, y: 4 }} animate={{ opacity: isDisappearing ? 0.6 : 1, y: 0 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
      className={`flex ${isMine?"justify-end":"justify-start"} group py-[2px] ${
        isActiveResult  ? "ring-2 ring-primary rounded-2xl"
        : isHighlighted ? "ring-1 ring-primary/40 rounded-2xl"
        : ""
      }`}>
      <div className="flex items-end gap-1 max-w-[80%]" {...lph}>
        {isMine && (
          <button onClick={onReply}
            className="h-6 w-6 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all text-muted-foreground hover:text-foreground mb-1">
            <Reply className="h-3 w-3" />
          </button>
        )}
        <div className={`rounded-2xl px-3 py-2 select-none ${
          isMine ? "bg-foreground text-background rounded-br-md" : "bg-card border border-border/50 rounded-bl-md"
        } ${isDisappearing ? "ring-1 ring-primary/20" : ""}`}>
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
            <div className={`rounded-xl px-3 py-2.5 mb-1 ${isMine?"bg-background/10":"bg-primary/5 border border-primary/15"}`}>
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
              <img onClick={() => onPhotoView(msg.file_url!)} src={msg.file_url} alt="shared"
                className="rounded-xl mb-1 max-h-44 object-cover w-full cursor-pointer active:scale-[0.98] transition-transform" />
            ) : (
              <button onClick={() => onPhotoView(msg.file_url!)}
                className={`flex items-center gap-2 mb-1 rounded-xl px-3 py-2.5 w-full ${isMine?"bg-background/10":"bg-muted/50"}`}>
                <ImageIcon className="h-4 w-4 shrink-0 opacity-50" />
                <span className="text-xs opacity-60">Photo — tap to view</span>
              </button>
            )
          )}
          {/* File */}
          {msg.message_type==="file" && msg.file_name && (
            <a href={msg.file_url||"#"} target="_blank" rel="noopener"
              className={`flex items-center gap-2 mb-1 rounded-lg px-2 py-1.5 ${isMine?"bg-background/10":"bg-muted/50"}`}>
              <FileText className="h-3.5 w-3.5 shrink-0 opacity-50" />
              <span className="text-xs truncate">{msg.file_name}</span>
            </a>
          )}
          {/* Text */}
          {msg.message_type!=="voice" && msg.message_type!=="letter" && msg.message_type!=="nudge" && msg.decryptedContent && (
            <p className="text-[14px] leading-relaxed whitespace-pre-wrap">{msg.decryptedContent}</p>
          )}
          <div className={`flex items-center gap-1 mt-0.5 ${isMine?"justify-end":""}`}>
            {isDisappearing && <Timer className="h-2.5 w-2.5 opacity-30" />}
            {msg.edited_at && <Pencil className="h-2 w-2 opacity-30" />}
            <span className={`text-[10px] ${isMine?"text-background/40":"text-muted-foreground/60"}`}>
              {formatTime(msg.created_at)}
            </span>
            {isMine && <MessageStatus isRead={msg.is_read} isMine={isMine} />}
          </div>
          <MessageReactions messageId={msg.id} userId={userId} isMine={isMine} allReactions={allReactions} />
        </div>
        {!isMine && (
          <button onClick={onReply}
            className="h-6 w-6 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all text-muted-foreground hover:text-foreground mb-1">
            <Reply className="h-3 w-3" />
          </button>
        )}
      </div>
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
  const fileInputRef    = useRef<HTMLInputElement>(null);
  const imageInputRef   = useRef<HTMLInputElement>(null);
  const cameraInputRef  = useRef<HTMLInputElement>(null);
  const messagesEndRef  = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder|null>(null);
  const audioChunksRef   = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval>|null>(null);
  // FIX: cancel flag for mic button race condition
  const recordingCancelledRef = useRef(false);
  const { chatWallpaper, appName, appIcon } = useTheme();
  const { user } = useAuth();
  const { ready: e2eReady, encrypt, decrypt } = useE2E(user?.id, partnerId);
  const { toast } = useToast();
  const [contextMenuMsg, setContextMenuMsg] = useState<DecryptedMessage|null>(null);
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
  } = useDailyCall();
  const [isStartingCall, setIsStartingCall] = useState(false);
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
    markedReadRef.current = new Set();
    fetchMessages();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, partnerId]);

  // FIX: load more passes the oldest created_at (not ID) — avoids stale messages dependency
  const loadMoreMessages = async () => {
    if (!hasMoreMessages || loadingMore || messages.length===0) return;
    isLoadingMoreRef.current = true;
    setLoadingMore(true);
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
  useEffect(() => {
    if (!user) return;
    const fetchImported = async () => {
      const { data } = await supabase
        .from("imported_chats" as any)
        .select("id,sender_name,content,original_timestamp,created_at")
        .eq("owner_id", user.id)
        .order("original_timestamp", { ascending: true });
      if (data) setImportedMessages(data as unknown as ImportedMessage[]);
    };
    fetchImported();
    // Listen for new batches being inserted (import in progress)
    const ch = supabase.channel(`imported-rt-${user.id}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "imported_chats",
          filter: `owner_id=eq.${user.id}` },
        (payload) => setImportedMessages(prev => [...prev, payload.new as unknown as ImportedMessage]))
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [user]);

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
      const dm: DecryptedMessage = { ...msg, decryptedContent: decrypted };
      setMessages(prev => [...prev, dm]);
      if (msg.sender_id !== user.id) {
        // Nudge flash
        if (msg.message_type==="nudge") {
          setNudgeFlash(true);
          hapticMedium();
          setTimeout(() => setNudgeFlash(false), 1500);
        }
        playMessageSound(); hapticMessageReceived();
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

  // FIX: auto-scroll ONLY on new messages appended (not when loading older ones)
  useEffect(() => {
    if (isLoadingMoreRef.current) return;
    messagesEndRef.current?.scrollIntoView({ behavior:"smooth" });
  }, [messages]);

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

  // Fix #Bug12: removed client-side setInterval that deleted expired messages from the DB.
  // The old approach caused a race: both partners independently ran DELETE on the same rows
  // every 5 s, causing duplicate deletes and Supabase constraint errors.
  // The UI still filters them out locally (messages with disappear_at <= now are hidden).
  // Actual DB deletion is handled by the Supabase pg_cron job / DB trigger on disappear_at
  // (see supabase/migrations — the trigger fires server-side, once, with no race).
  useEffect(() => {
    const id = setInterval(() => {
      const now = new Date();
      // Only update local state — never touch the DB from the client for expiry
      setMessages(prev =>
        prev.filter(m => !m.disappear_at || m.disappear_at === "pending" || new Date(m.disappear_at) > now)
      );
    }, 5000);
    return () => clearInterval(id);
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
    const text = message;
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
      });
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

    // FIX AUDIT #6: rate-limit room creation (max 2 per minute)
    if (!callRoomLimiter.allow()) {
      const wait = formatRetryDelay(callRoomLimiter.retryAfterMs());
      toast({ title: "Please wait", description: `You can start another call in ${wait}.`, variant: "destructive" });
      return;
    }

    setIsStartingCall(true);
    try {
      // Mic-only probe — Daily.co requests camera itself when joining,
      // and probing video here can race PeekGuard / cameraBus consumers.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      stream.getTracks().forEach(t=>t.stop());
      playCallSound();
      const { data, error:fnErr } = await supabase.functions.invoke("daily-call",{ body:{ action:"create-room", roomName:`duo-${user.id.slice(0,8)}-${Date.now()}` } });
      if (fnErr||data?.error) throw new Error(data?.error||fnErr?.message||"Failed to create room");
      const { data:tokenData, error:tokErr } = await supabase.functions.invoke("daily-call",{ body:{ action:"get-token", roomName:data.name } });
      if (tokErr||tokenData?.error) throw new Error(tokenData?.error||tokErr?.message||"Failed to get token");
      const { data:callRecord } = await supabase.from("call_history").insert({
        caller_id:user.id, receiver_id:partnerId, call_type:mode,
        call_direction:"outgoing", status:"in_progress",
        room_name:data.url, started_at:new Date().toISOString(),
      } as any).select().single();
      if (callRecord) setCurrentCallId((callRecord as any).id);
      // CALL-02 FIX: pass videoOff=true for voice calls so camera never opens
      await joinCall(data.url, tokenData.token, mode === "voice");
      toast({ title:mode==="video"?"Video call started 📹":"Voice call started 📞" });
    } catch (err: unknown) {
      toast({ title:"Call failed", description:(err instanceof Error ? err.message : String(err)), variant:"destructive" });
    }
    setIsStartingCall(false);
  };

  const handleAcceptIncoming = useCallback(async (roomUrl: string, callType: string) => {
    if (isStartingCall) return; // CALL-01 FIX: guard against double-accept
    setIsStartingCall(true);
    try {
      const { data:tokenData, error:tokErr } = await supabase.functions.invoke("daily-call",{ body:{ action:"get-token", roomName:roomUrl.split("/").pop() } });
      if (tokErr||tokenData?.error) throw new Error("Failed to get token");
      // CALL-02 FIX: use videoOff flag instead of toggleVideo() after join
      await joinCall(roomUrl, tokenData.token, callType === "voice");
      toast({ title:"Call connected 📞" });
    } catch (err: unknown) { toast({ title:"Couldn't join call", description:(err instanceof Error ? err.message : String(err)), variant:"destructive" }); }
    setIsStartingCall(false);
  }, [joinCall, isStartingCall, toast]);

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
    return diff !== 0 ? diff : a.data.id.localeCompare(b.data.id); // BUG-15 stable sort
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
        className="flex flex-col h-[100dvh] bg-destructive/10 items-center justify-center gap-4 px-6">
        <div className="text-center space-y-2">
          <PhoneOff className="h-12 w-12 text-destructive mx-auto" />
          <p className="text-base font-semibold text-foreground">Call failed</p>
          {callError && <p className="text-sm text-muted-foreground">{callError}</p>}
        </div>
        <button onClick={leaveCall}
          className="h-11 px-6 rounded-full bg-foreground text-background text-sm font-medium">
          Back to chat
        </button>
      </motion.div>
    );
  }

  if (callState==="joined"||callState==="joining") {
    return (
      <motion.div initial={{ opacity:0 }} animate={{ opacity:1 }}
        className="flex flex-col h-[100dvh] bg-[hsl(var(--foreground))] relative">
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
        {callState==="joining" && (
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
            <div className={`h-1.5 w-1.5 rounded-full ${callNetworkQuality==="excellent"||callNetworkQuality==="good"?"bg-green-400":callNetworkQuality==="fair"?"bg-yellow-400":"bg-red-400"}`} />
            <span className="text-[11px] text-background/80 font-mono">{formatCallDuration(callDuration)}</span>
          </div>
          {isScreenSharing && <div className="bg-primary/60 backdrop-blur-md rounded-full px-3 py-1.5 flex items-center gap-1"><Monitor className="h-3 w-3 text-background" /><span className="text-[10px] text-background">Sharing</span></div>}
          <button onClick={() => setShowLipReading(v=>!v)}
            aria-label={showLipReading ? "Disable lip reading" : "Enable lip reading"}
            aria-pressed={showLipReading}
            className={`ml-auto rounded-full px-3 py-1.5 flex items-center gap-1.5 backdrop-blur-md transition-colors ${showLipReading?"bg-green-500/80":"bg-background/15"}`}>
            <Captions className="h-3.5 w-3.5 text-background" aria-hidden="true" />
            <span className="text-[10px] text-background font-medium">{showLipReading?"Reading":"Lip Read"}</span>
          </button>
        </div>
        <AnimatePresence>
          {showLipReading && callState==="joined" && <LipReadingOverlay videoRef={remoteVideoRef} onClose={() => setShowLipReading(false)} />}
        </AnimatePresence>
        <div className="absolute bottom-10 left-0 right-0 z-10 safe-bottom" role="toolbar" aria-label="Call controls">
          <div className="flex items-center justify-center gap-4">
            <button onClick={toggleAudio}
              aria-label={isAudioOn ? "Mute microphone" : "Unmute microphone"}
              aria-pressed={!isAudioOn}
              className={`h-12 w-12 rounded-full flex items-center justify-center transition-colors ${isAudioOn?"bg-background/15 backdrop-blur-md":"bg-destructive"}`}>
              {isAudioOn?<Mic className="h-5 w-5 text-background" aria-hidden="true" />:<MicOff className="h-5 w-5 text-background" aria-hidden="true" />}
            </button>
            <button onClick={toggleVideo}
              aria-label={isVideoOn ? "Turn off camera" : "Turn on camera"}
              aria-pressed={!isVideoOn}
              className={`h-12 w-12 rounded-full flex items-center justify-center transition-colors ${isVideoOn?"bg-background/15 backdrop-blur-md":"bg-destructive"}`}>
              {isVideoOn?<Video className="h-5 w-5 text-background" aria-hidden="true" />:<VideoOff className="h-5 w-5 text-background" aria-hidden="true" />}
            </button>
            <button onClick={toggleScreenShare}
              aria-label={isScreenSharing ? "Stop screen share" : "Start screen share"}
              aria-pressed={isScreenSharing}
              className={`h-12 w-12 rounded-full flex items-center justify-center transition-colors ${isScreenSharing?"bg-primary":"bg-background/15 backdrop-blur-md"}`}>
              {isScreenSharing?<MonitorOff className="h-5 w-5 text-background" aria-hidden="true" />:<Monitor className="h-5 w-5 text-background" aria-hidden="true" />}
            </button>
            <button onClick={endCall}
              aria-label="End call"
              className="h-14 w-14 rounded-full bg-destructive flex items-center justify-center shadow-lg">
              <PhoneOff className="h-6 w-6 text-background" aria-hidden="true" />
            </button>
          </div>
        </div>
      </motion.div>
    );
  }

  return (
    <div className="flex flex-col h-[100dvh] bg-background overflow-hidden">
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
      <header className="safe-top px-4 pt-3 pb-2.5 bg-background border-b border-border/40 sticky top-0 z-10">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-full bg-muted flex items-center justify-center overflow-hidden">
              {partnerAvatar ? (
                <img src={partnerAvatar} alt="" className="h-full w-full object-cover" />
              ) : appIcon ? (
                <img src={appIcon} alt={appName} className="h-full w-full object-cover" />
              ) : (
                <span className="text-[10px] font-semibold text-muted-foreground">{appName.slice(0,2).toUpperCase()}</span>
              )}
            </div>
            <div>
              <h1 className="text-sm font-semibold text-foreground leading-tight">
                {partnerId ? partnerName : appName}
              </h1>
              <p className="text-[11px] text-muted-foreground leading-tight">
                {partnerTyping?"typing...":partnerOnline?"🟢 online":e2eReady?"end-to-end encrypted":partnerId?"securing…":"Link a partner in settings"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {/* Nudge button */}
            {partnerId && (
              <button onClick={sendNudge}
                aria-label="Send nudge"
                className="h-9 w-9 rounded-full flex items-center justify-center text-muted-foreground hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors">
                <Heart className="h-[17px] w-[17px]" aria-hidden="true" />
              </button>
            )}
            <button onClick={() => startCall("video")} disabled={isStartingCall||!partnerId}
              aria-label="Start video call"
              className="h-9 w-9 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-30">
              <Video className="h-[18px] w-[18px]" aria-hidden="true" />
            </button>
            <button onClick={() => startCall("voice")} disabled={isStartingCall||!partnerId}
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
                <DropdownMenuItem onClick={() => { setSearchOpen(!searchOpen); setSearchQuery(""); if(!searchOpen) setTimeout(()=>searchInputRef.current?.focus(),100); }}>
                  <Search className="h-4 w-4 mr-2.5" /> Search
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => disappearMode ? setDisappearMode(false) : setShowDisappearSheet(true)}>
                  {disappearMode ? <Timer className="h-4 w-4 mr-2.5" /> : <TimerOff className="h-4 w-4 mr-2.5" />}
                  {disappearMode ? "Disable disappearing" : "Disappearing messages"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => navigate("/settings")}>Settings</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={recoverChat}>
                  <Reply className="h-4 w-4 mr-2.5" /> Recover chat
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setShowClearDialog(true)} className="text-destructive focus:text-destructive">
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
                    <button onClick={() => setSearchIndex(i=>Math.max(0,i-1))} aria-label="Previous match" className="h-6 w-6 flex items-center justify-center text-muted-foreground"><ChevronUp className="h-3.5 w-3.5" aria-hidden="true" /></button>
                    <button onClick={() => setSearchIndex(i=>Math.min(searchResults.length-1,i+1))} aria-label="Next match" className="h-6 w-6 flex items-center justify-center text-muted-foreground"><ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /></button>
                  </div>
                )}
                <button onClick={() => { setSearchOpen(false); setSearchQuery(""); }} aria-label="Close search" className="h-6 w-6 flex items-center justify-center text-muted-foreground"><X className="h-3.5 w-3.5" aria-hidden="true" /></button>
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
              <Timer className="h-3 w-3 text-primary" />
              <span className="text-[10px] text-primary font-medium">
                Disappear after {DISAPPEAR_OPTIONS.find(o=>o.value===disappearMs)?.label||"30 seconds"} • Tap timer to change
              </span>
              <button onClick={() => setShowDisappearSheet(true)} className="ml-1 text-[10px] text-primary underline">change</button>
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
        className="flex-1 overflow-y-auto px-3 py-3 min-h-0"
        style={chatWallpaper ? {
          backgroundImage: chatWallpaper.startsWith("url(") ? chatWallpaper : undefined,
          background: chatWallpaper.startsWith("linear") ? chatWallpaper : undefined,
          backgroundSize:"cover", backgroundPosition:"center",
        } : undefined}>
        {hasMoreMessages && (
          <div className="flex justify-center mb-3">
            <button onClick={loadMoreMessages} disabled={loadingMore}
              className="text-[11px] text-muted-foreground bg-muted/50 px-4 py-1.5 rounded-full active:scale-95 transition-transform disabled:opacity-50">
              {loadingMore?"Loading…":"Load older messages"}
            </button>
          </div>
        )}
        {messagesLoading && <div className="flex justify-center my-8"><p className="text-xs text-muted-foreground animate-pulse">Loading messages…</p></div>}
        {messagesError && !messagesLoading && (
          <div className="flex flex-col items-center gap-2 my-8">
            <p className="text-xs text-muted-foreground text-center">{messagesError}</p>
            <button onClick={() => fetchMessages()} className="text-[11px] text-primary underline">Retry</button>
          </div>
        )}
        {groupedTimeline.map(group => (
          <div key={group.date}>
            <div className="flex justify-center my-3">
              <span className="text-[10px] text-muted-foreground bg-muted/50 backdrop-blur-sm px-3 py-1 rounded-full">{group.date}</span>
            </div>
            <div className="space-y-0.5">
              {group.items.map(item => {
                if (item.type==="call") {
                  const c = item.data;
                  return <CallEvent key={`call-${c.id}`} callType={c.call_type} status={c.status} direction={c.call_direction} durationSeconds={c.duration_seconds} createdAt={c.created_at} isMine={c.caller_id===user?.id} />;
                }
                // WA-01 FIX: render imported WhatsApp messages as distinct read-only bubbles
                if (item.type==="imported") {
                  const imp = item.data as ImportedMessage;
                  const impTime = new Date(imp.original_timestamp).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });
                  // Heuristic: if sender_name matches the user's own display name, show on right
                  // We don't have a reliable mapping so we always show on left with sender label
                  return (
                    <div key={`imp-${imp.id}`} className="flex justify-start px-3 py-0.5">
                      <div className="max-w-[75%] bg-muted/40 border border-border/40 rounded-2xl rounded-tl-sm px-3 py-2 space-y-0.5">
                        <p className="text-[10px] font-semibold text-primary/70">{imp.sender_name}</p>
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
                return (
                  <MessageBubble key={msg.id} msg={msg} isMine={msg.sender_id===user?.id}
                    isDisappearing={!!msg.disappear_at&&msg.disappear_at!=="pending"}
                    isHighlighted={searchResults.includes(msg.id)} isActiveResult={searchResults[searchIndex]===msg.id}
                    repliedMsg={repliedMsg} partnerName={partnerName} userId={user?.id||""}
                    onReply={() => { setReplyTo(msg); inputRef.current?.focus(); }}
                    onLongPress={() => setContextMenuMsg(msg)}
                    onPhotoView={url=>setViewingPhoto(url)}
                    formatTime={formatTime} allReactions={allReactions} mediaVisible={mediaVisible}
                  />
                );
              })}
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
          <motion.div initial={{ opacity:0,y:8 }} animate={{ opacity:1,y:0 }} exit={{ opacity:0,y:8 }} className="px-4 pb-1 flex gap-2">
            <button onClick={() => imageInputRef.current?.click()} className="flex items-center gap-1.5 bg-muted/60 rounded-full px-3 py-2 text-xs"><ImageIcon className="h-3.5 w-3.5 text-muted-foreground" /> Photo</button>
            <button onClick={() => cameraInputRef.current?.click()} className="flex items-center gap-1.5 bg-muted/60 rounded-full px-3 py-2 text-xs"><Camera className="h-3.5 w-3.5 text-muted-foreground" /> Camera</button>
            <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-1.5 bg-muted/60 rounded-full px-3 py-2 text-xs"><FileText className="h-3.5 w-3.5 text-muted-foreground" /> File</button>
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
            className="px-4 py-2 bg-blue-500/10 border-t border-blue-500/20 flex items-center gap-2">
            <Pencil className="h-3.5 w-3.5 text-blue-500 shrink-0" />
            <span className="text-[11px] text-blue-600 flex-1 truncate">Editing message</span>
            <button onClick={() => { setEditingMsg(null); setEditText(""); setMessage(""); }} aria-label="Cancel edit">
              <X className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Input area */}
      <div className="px-3 pb-3 pt-1.5 safe-bottom bg-background shrink-0">
        {isRecording ? (
          <motion.div initial={{ opacity:0,scale:0.97 }} animate={{ opacity:1,scale:1 }}
            className="flex items-center gap-3 bg-destructive/5 rounded-full border border-destructive/10 px-4 py-2.5">
            <motion.div animate={{ opacity:[1,0.3,1] }} transition={{ repeat:Infinity,duration:1 }} className="h-2 w-2 rounded-full bg-destructive shrink-0" />
            <span className="text-sm font-medium text-destructive flex-1">{formatRecTime(recordingTime)}</span>
            <button onClick={cancelRecording} aria-label="Cancel voice recording" className="h-8 w-8 rounded-full bg-muted flex items-center justify-center"><Trash2 className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" /></button>
            <button onClick={stopRecording} aria-label="Send voice recording" className="h-8 w-8 rounded-full bg-foreground flex items-center justify-center"><Send className="h-3.5 w-3.5 text-background" aria-hidden="true" /></button>
          </motion.div>
        ) : (
          <div className="flex items-center gap-1.5">
            <div className="flex-1 flex items-center gap-1 bg-muted/30 rounded-full border border-border/30 px-2 py-1">
              <button onClick={() => setShowAttach(!showAttach)}
                aria-label="Attachments"
                aria-expanded={showAttach}
                className="h-8 w-8 rounded-full flex items-center justify-center shrink-0 text-muted-foreground hover:text-foreground transition-colors">
                <Paperclip className="h-4 w-4" aria-hidden="true" />
              </button>
              <input ref={inputRef} type="text" value={message}
                aria-label="Message"
                onChange={e => { setMessage(e.target.value); broadcastTyping(); if(editingMsg) setEditText(e.target.value); }}
                onKeyDown={e => e.key==="Enter" && handleSend()}
                placeholder={editingMsg?"Edit message...":replyTo?"Reply...":"Message"}
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60 py-1.5" />
            </div>
            {message.trim() ? (
              <motion.button initial={{ scale:0 }} animate={{ scale:1 }} onClick={handleSend}
                aria-label={editingMsg ? "Save edit" : "Send message"}
                className="h-10 w-10 rounded-full bg-foreground flex items-center justify-center shrink-0">
                {editingMsg ? <Check className="h-4 w-4 text-background" aria-hidden="true" /> : <Send className="h-4 w-4 text-background" aria-hidden="true" />}
              </motion.button>
            ) : (
              <button
                onPointerDown={startRecording}
                onPointerUp={stopRecording}
                aria-label="Hold to record voice message"
                // Fix #Bug4: pointer events unify touch+mouse — no double-fire on Android/iOS.
                // onMouseDown/onTouchStart both fired on mobile causing startRecording() twice.
                onPointerLeave={() => { if (isRecording) cancelRecording(); }}
                style={{ touchAction: "none" }}
                className="h-10 w-10 rounded-full bg-foreground flex items-center justify-center shrink-0 active:scale-95 transition-transform">
                <Mic className="h-4 w-4 text-background" aria-hidden="true" />
              </button>
            )}
            <HubButton onClick={() => setShowGridMenu(!showGridMenu)} isOpen={showGridMenu} />
          </div>
        )}
      </div>

      {/* Hidden inputs */}
      <input ref={imageInputRef} type="file" accept="image/*,video/*" className="hidden" onChange={e=>handleFileSelect(e,"image")} />
      <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={e=>handleFileSelect(e,"image")} />
      <input ref={fileInputRef} type="file" className="hidden" onChange={e=>handleFileSelect(e,"file")} />

      {/* Disappearing timer sheet */}
      <Sheet open={showDisappearSheet} onOpenChange={setShowDisappearSheet}>
        <SheetContent side="bottom" className="rounded-t-2xl pb-safe">
          <SheetHeader className="mb-4"><SheetTitle className="text-base">Disappearing messages</SheetTitle></SheetHeader>
          <div className="space-y-2">
            {DISAPPEAR_OPTIONS.map(opt => (
              <button key={opt.value} onClick={() => { setDisappearMs(opt.value); setDisappearMode(true); setShowDisappearSheet(false); }}
                className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-colors ${
                  disappearMode && disappearMs===opt.value ? "bg-primary/10 border-primary/30" : "bg-card border-border/50"
                }`}>
                <span className="text-sm">{opt.label}</span>
                {disappearMode && disappearMs===opt.value && <Check className="h-4 w-4 text-primary" />}
              </button>
            ))}
            <button onClick={() => { setDisappearMode(false); setShowDisappearSheet(false); }}
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
            <AlertDialogAction onClick={clearChat} className="rounded-full bg-destructive text-destructive-foreground text-xs h-8">Clear</AlertDialogAction>
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

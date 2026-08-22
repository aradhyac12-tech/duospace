import { motion, AnimatePresence } from "framer-motion";
import {
  ImageIcon, FileText, Camera, Timer, Check,
} from "lucide-react";
import PinnedMessageBanner from "@/components/chat/PinnedMessageBanner";
import CallOverlay from "@/components/chat/CallOverlay";
import ChatHeader from "@/components/chat/ChatHeader";
import MessageComposer from "@/components/chat/MessageComposer";
import MessageTimeline from "@/components/chat/MessageTimeline";
import { useReactionsChannel } from "@/components/chat/MessageReactions";
import { dispatchEmojiEffect } from "@/components/EmojiScreenEffect";
import PhotoViewer from "@/components/chat/PhotoViewer";
import GridMenu from "@/components/chat/GridMenu";
import MessageContextMenu from "@/components/chat/MessageContextMenu";
import ChatSurpriseHost from "@/components/chat/ChatSurpriseHost";
import ScheduledMessagePicker from "@/components/chat/ScheduledMessagePicker";
import LoveLetter from "@/components/chat/LoveLetter";
import { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useTheme } from "@/contexts/ThemeContext";
import { useDockCompactReporter } from "@/hooks/useDockCompact";
import { resolveWallpaperStyle } from "@/lib/wallpapers";
import { supabase } from "@/integrations/supabase/client";
import { playMessageSound, playCallSound } from "@/lib/sounds";
import { hapticLight, hapticMedium, hapticSelection, hapticError, hapticMessageSent } from "@/lib/haptics";
import { useMediaPermission } from "@/components/PermissionDeniedSheet";
import { useCallOutcome } from "@/hooks/useCallOutcome";
import { useAuth } from "@/hooks/useAuth";
import { useE2E } from "@/hooks/useE2E";
import storage from "@/lib/storage";
import { useCall } from "@/contexts/CallContext";
import { useToast } from "@/hooks/use-toast";
import { invokeEdgeFunction } from "@/lib/edgeFunction";
import { extractErrorMessage } from "@/lib/errorMessage";
import { resolveSignedUrl } from "@/lib/signedStorageUrl";
import { resumableUpload } from "@/lib/resumableUpload";
import { logError, logWarn } from "@/lib/telemetry";
import { callRoomLimiter, scheduledMsgLimiter, formatRetryDelay } from "@/lib/rateLimit";
import { useReconnectRefetch, createSendDedup } from "@/lib/networkState";
import { useKeyboardOpen } from "@/hooks/useKeyboardOpen";
import type { Message, DecryptedMessage, CallEntry, ImportedMessage, TimelineItem } from "@/types/chat";
import { DISAPPEAR_OPTIONS, DEFAULT_DISAPPEAR_MS } from "@/lib/chatConstants";
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

// No hard cap on messages — load 200 per page with infinite scroll.
const PAGE_SIZE = 200;

// In-memory cache of the last-loaded conversation for this app session —
// a plain module variable, not React state, so it survives Chat
// unmounting/remounting when the person navigates to another tab and back
// (React Router fully unmounts route components on navigation, which was
// wiping `messages` and forcing a full skeleton-loading refetch every
// single time the person reopened Chat). Deliberately kept in memory only,
// never written to disk/IndexedDB: this holds decrypted plaintext of an
// end-to-end-encrypted, sometimes-disappearing conversation, so it should
// vanish on app close/reload the same way the rest of the E2E/disappearing-
// message code already assumes. Keyed by userId + partnerId so a stale
// cache can never flash for the wrong account or the wrong partner.
let messageCache: { userId: string; partnerId: string; messages: DecryptedMessage[] } | null = null;

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
  const [viewingPhoto, setViewingPhoto] = useState<{ url: string; id: string } | null>(null);
  const [partnerId, setPartnerId]       = useState<string|null>(null);
  const [partnerName, setPartnerName]   = useState("");
  const [partnerAvatar, setPartnerAvatar] = useState<string|null>(null);
  const [replyTo, setReplyTo]           = useState<DecryptedMessage|null>(null);
  // ─── Optimistic sending ───────────────────────────────────────────────────
  // Retry payloads for messages currently shown with _sendStatus "failed" —
  // keyed by the optimistic message's clientId (its temporary `id` while
  // pending). Only ever holds entries for messages the user could still
  // retry; cleared the moment a retry succeeds or the message is removed.
  // A ref (not state) since it's never itself rendered — only read/written
  // from inside send/retry handlers.
  const pendingSendPayloads = useRef(new Map<string, () => Promise<void>>());
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
  // Keyboard audit (section 16): "keyboard reopening incorrectly after
  // navigation". Relying on React unmounting the composer's <input> to
  // also tear down the native keyboard isn't reliable in a Capacitor
  // WebView — a focused input that's removed from the DOM without an
  // explicit blur() first can leave the native keyboard state confused,
  // which is a plausible source of it seeming to "come back" on the next
  // visit to this route even though nothing here re-focuses it (confirmed
  // via grep: no autoFocus anywhere on this input, and this whole page
  // unmounts on navigation — there's no keep-alive/persisted DOM that
  // could hold stale focus). Explicit blur on unmount closes that gap
  // without depending on unmount-ordering behavior that varies by
  // platform/WebView version.
  useEffect(() => {
    return () => { inputRef.current?.blur(); };
  }, []);
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
  // Phase 1: while the conversation is actively scrolling, the floating
  // dock compresses slightly (never hides — see useDockCompact.ts) and
  // restores as soon as scrolling stops or the user's back near the top.
  useDockCompactReporter(messagesContainerRef);
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
  const { chatWallpaper, colorMode, appName, appIcon, appSettings } = useTheme();
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
  // Hydrate instantly from the in-session cache (see messageCache above) —
  // runs as a layout effect so it commits before the browser paints,
  // meaning a person reopening a conversation they already had loaded
  // never sees the loading skeleton at all, just the messages already
  // there. Guarded on userId so it can never show one account's cached
  // conversation to a different signed-in account.
  useLayoutEffect(() => {
    if (user && messageCache && messageCache.userId === user.id) {
      setMessages(messageCache.messages);
      setMessagesLoading(false);
    }
  }, [user]);
  const { ready: e2eReady, encrypt, decrypt } = useE2E(user?.id, partnerId);
  const { toast } = useToast();
  const [contextMenuMsg, setContextMenuMsg] = useState<DecryptedMessage|null>(null);
  // Held separately from contextMenuMsg: the long-press sheet closes (and
  // nulls contextMenuMsg) the instant Delete is tapped, but the confirm
  // dialog that follows still needs to know which message is pending.
  const [pendingDeleteMsg, setPendingDeleteMsg] = useState<DecryptedMessage|null>(null);
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
    callDuration, autoAudioFallback,
    activeCallId: currentCallId, setActiveCallId: setCurrentCallId, isAcceptingCall,
  } = useCall();
  const [isStartingCall, setIsStartingCall] = useState(false);
  // Tracks whether *this* call session has ever had a second participant
  // join — see src/lib/callUiState.ts. Distinguishes "still ringing" from
  // "partner left" for CallOverlay, which previously showed the same
  // "Ringing..." text for both.
  const [everConnected, setEverConnected] = useState(false);
  const [callMode, setCallMode] = useState<"video" | "voice">("video");
  useEffect(() => {
    if (participantCount > 1) setEverConnected(true);
  }, [participantCount]);
  const { ensure: ensureCallMedia, permissionSheet: callPermissionSheet } = useMediaPermission();
  // BUG FIX (call latency): the call screen now appears the instant the
  // button is tapped (isStartingCall), before the network setup that used
  // to gate it has even started — see the render gate below. That means
  // the hang-up button is now reachable *during* that setup, which wasn't
  // possible before. This flag lets a cancel during that window stop
  // startCall()'s in-flight async work from finishing the job (joining a
  // call the person already tried to back out of) instead of just
  // resetting local UI state and letting it join anyway a moment later.
  const callCancelledRef = useRef(false);
  // currentCallId/setCurrentCallId now come from CallContext (activeCallId)
  // so they stay correct even when a call was accepted while this page
  // wasn't mounted — see CallContext.tsx.

  // CONFIRMED BUG FIX — see useCallOutcome.ts: the caller previously had
  // no way to find out the receiver declined/timed out/the call was
  // cancelled from another session, and CallOverlay just sat on
  // "Ringing…" forever with no feedback.
  const { outcome: callOutcome, dismissOutcome: dismissCallOutcome } = useCallOutcome({
    currentCallId,
    everConnected,
    onRemoteEnded: () => {
      leaveCall();
      setCurrentCallId(null);
      setIsStartingCall(false);
    },
  });

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
    if (!beforeCreatedAt) {
      // Only show the full loading skeleton when there's nothing on screen
      // yet. If this conversation is already cached (see messageCache), the
      // hydration layout effect above has already put it on screen — this
      // call just reconciles with the server quietly in the background
      // instead of flashing a skeleton over messages the person can already
      // see and read.
      const alreadyShowingThisConversation =
        messageCache?.userId === user.id && messageCache?.partnerId === partnerId;
      if (!alreadyShowingThisConversation) setMessagesLoading(true);
      setMessagesError(null);
    }

    // FIX (Clear Chat leaking across partners): this used to scope the
    // conversation with one .or() for sender/receiver membership, then
    // apply .neq("deleted_by_sender",true).neq("deleted_by_receiver",true)
    // as a blanket filter across BOTH directions. deleted_by_sender and
    // deleted_by_receiver are per-VIEWER hide flags — clearChat() below
    // only ever sets deleted_by_sender=true on rows where the CALLER is the
    // sender, and deleted_by_receiver=true on rows where the caller is the
    // receiver, so each flag only reflects whether *that* side's user
    // cleared it. But a blanket .neq() on both columns excludes a row if
    // EITHER flag is true no matter which user set it — so when your
    // partner cleared their own view, their deleted_by_sender=true (on
    // partner→you rows) and deleted_by_receiver=true (on you→partner rows)
    // silently hid the entire conversation from YOUR fetch too, even
    // though your own deleted_by_* flags were never touched. That's what
    // produced "Start your conversation" for a chat that still had every
    // message intact in the DB. The filter now checks the flag that
    // actually corresponds to the current user's role on each row.
    let query: any = supabase.from("messages").select("id,sender_id,receiver_id,content,message_type,file_url,file_name,is_read,reply_to_id,disappear_at,deleted_by_sender,deleted_by_receiver,created_at")
      .or(
        `and(sender_id.eq.${user.id},receiver_id.eq.${partnerId},deleted_by_sender.neq.true),`+
        `and(sender_id.eq.${partnerId},receiver_id.eq.${user.id},deleted_by_receiver.neq.true)`
      )
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
    // Discard a cache left over from a different partner (only reachable
    // via re-pairing) so it can never flash for the wrong conversation —
    // the userId check in the hydration effect above already prevents
    // this for a different *account*, this covers a different *partner*
    // on the same account.
    if (messageCache && (messageCache.userId !== user.id || messageCache.partnerId !== partnerId)) {
      setMessages([]);
      messageCache = null;
    }
    markedReadRef.current = new Set();
    didInitialScrollRef.current = false; // new conversation — next load jumps instantly, no smooth animation
    pendingScrollRestoreRef.current = null;
    fetchMessages();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, partnerId, e2eReady]);

  // Keep the in-session cache mirroring the live conversation state —
  // covers every way `messages` can change (realtime deliveries, edits,
  // reactions, pin, Clear Chat, pagination) with one sync point instead of
  // threading a cache write through every individual setMessages call.
  // Gated on `!messagesLoading` so a transient pre-load empty array is
  // never mistaken for a genuinely-empty (e.g. just-cleared) conversation.
  useEffect(() => {
    if (user && partnerId && !messagesLoading) {
      messageCache = { userId: user.id, partnerId, messages };
    }
  }, [messages, partnerId, user, messagesLoading]);

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
  const resolveImportedUrls = useCallback((rows: ImportedMessage[]) =>
    Promise.all(rows.map(async r => ({
      ...r,
      // Imported media is uploaded to the same private "chat-files"
      // bucket as everything else — resolve to a signed URL the same way
      // real message attachments are (see decryptMessages above).
      file_url: r.file_url ? await resolveSignedUrl("chat-files", r.file_url) : r.file_url,
    }))), []);
  // Hoisted out of the effect below (was a local const, only reachable by
  // that effect's own initial call) so clearChat/recoverChat can also
  // trigger a refetch after they change which rows are hidden for this
  // viewer — see the cleared_by filter this now applies below.
  const fetchImportedMessages = useCallback(async () => {
    if (!user || !partnerId) return;
    const { data } = await supabase
      .from("imported_chats" as any)
      .select("id,sender_name,content,original_timestamp,created_at,is_self,file_url,file_type,import_batch_id,cleared_by")
      .in("owner_id", [user.id, partnerId])
      // BUG FIX: this is the read side of the clearChat fix — rows the
      // viewer has cleared (their own uid present in cleared_by, see the
      // imported_chats_per_viewer_clear migration) are excluded, same as
      // deleted_by_sender/receiver already does for the `messages` table.
      .not("cleared_by", "cs", `{${user.id}}`)
      .order("original_timestamp", { ascending: true });
    if (data) setImportedMessages(await resolveImportedUrls(data as unknown as ImportedMessage[]));
  }, [user, partnerId, resolveImportedUrls]);
  useEffect(() => {
    if (!user || !partnerId) return;
    fetchImportedMessages();
    // Listen for new batches being inserted (import in progress) and for
    // rows being removed (Undo import), from either partner.
    // postgres_changes only supports one equality filter per listener, so
    // register one per owner_id per event and dedupe by row id.
    const seenIds = new Set<string>();
    const handleInsert = async (payload: { new: Record<string, unknown> }) => {
      const row = payload.new as unknown as ImportedMessage;
      if (seenIds.has(row.id)) return;
      seenIds.add(row.id);
      const [resolved] = await resolveImportedUrls([row]);
      setImportedMessages(prev => prev.some(m => m.id === resolved.id) ? prev : [...prev, resolved]);
    };
    const handleDelete = (payload: { old: Record<string, unknown> }) => {
      const id = (payload.old as any)?.id;
      if (id) setImportedMessages(prev => prev.filter(m => m.id !== id));
    };
    const ch = supabase.channel(`imported-rt-${[user.id, partnerId].sort().join("-")}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "imported_chats",
          filter: `owner_id=eq.${user.id}` }, handleInsert)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "imported_chats",
          filter: `owner_id=eq.${partnerId}` }, handleInsert)
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "imported_chats",
          filter: `owner_id=eq.${user.id}` }, handleDelete)
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "imported_chats",
          filter: `owner_id=eq.${partnerId}` }, handleDelete)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [user, partnerId, fetchImportedMessages, resolveImportedUrls]);

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
      // FIX: guard against a message already present from the initial fetchMessages()
      // load (or a realtime reconnect replay) being appended a second time — seenIds
      // above only dedupes the two postgres_changes listeners on this channel, not
      // against messages already in state.
      setMessages(prev => prev.some(m => m.id === dm.id) ? prev : [...prev, dm]);
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

  // Keyboard audit (section 16): "content jumping" / "incorrect scroll
  // position". With Keyboard.resize:"body" (capacitor.config.json), the
  // viewport genuinely shrinks when the keyboard opens — the messages
  // container's clientHeight drops, but browsers don't auto-adjust
  // scrollTop to compensate, so someone reading the latest message can
  // suddenly find the conversation scrolled up away from the bottom the
  // instant they tap the composer, purely because less of the page fits.
  // Only re-anchors if they were already within ~120px of the bottom right
  // before the keyboard opened — if they were reading older messages
  // further up, this deliberately leaves their position alone, same
  // principle as the "don't force-scroll while reading old messages"
  // behavior elsewhere on this page. `behavior: "auto"` (instant, not
  // smooth) since this is a correction for a layout shift that already
  // happened, not a new-message entrance to animate.
  const keyboardOpen = useKeyboardOpen();
  const wasKeyboardOpenRef = useRef(false);
  useEffect(() => {
    const container = messagesContainerRef.current;
    const justOpened = keyboardOpen && !wasKeyboardOpenRef.current;
    wasKeyboardOpenRef.current = keyboardOpen;
    if (!justOpened || !container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom < 120) messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
  }, [keyboardOpen]);

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

    // Mark received messages as read.
    // FIX (disappear/reappear flicker): this used to ALSO resolve pending
    // disappear_at for received messages here, on top of the sender-side
    // resolution above. Both sides raced to write disappear_at for the
    // same row with two different computed expiry times — whichever write
    // landed last in the DB "won", silently overwriting the other. Each
    // client's local disappear timer (below) is scheduled once against
    // whatever expiry it saw first and is never rescheduled, so when the
    // DB's real value differed from what a client had already scheduled
    // against, the message could vanish locally at the wrong time and then
    // come back at the next fetch (reconnect, pagination, etc.) because
    // the row was, per the DB's actual disappear_at, not expired yet.
    // Per BUG FIX #08 above, the sender is the sole owner of resolving
    // "pending" → a real timestamp; the receiver only ever flips is_read.
    const unread = messages.filter(m => m.sender_id===partnerId && !m.is_read && !markedReadRef.current.has(m.id));
    if (!unread.length) return;
    unread.forEach(m => markedReadRef.current.add(m.id));
    const unreadIds = unread.map(m=>m.id);
    const run = async () => {
      await supabase.from("messages").update({ is_read:true }).in("id",unreadIds);
      setMessages(prev => prev.map(m => unreadIds.includes(m.id) ? { ...m, is_read:true } : m));
    };
    run();
  }, [messages,user,partnerId]);

  // BUG FIX / POLISH (premium disappearing-message behavior): this used to
  // batch-check every 5s and mass-filter whatever had expired, so messages
  // could sit up to 5s past their real expiry and several could vanish in
  // one visible clump. Each disappearing message now gets its own
  // setTimeout fired at the *exact* instant it expires, so it disappears
  // precisely on time and plays its own individual exit animation instead
  // of several popping at once. DB deletion still happens server-side via
  // the pg_cron sweep (see delete_expired_messages) — this only ever
  // touches local UI state.
  const disappearTimersRef = useRef<Map<string, { at: string; timer: ReturnType<typeof setTimeout> }>>(new Map());
  useEffect(() => {
    const scheduled = disappearTimersRef.current;
    const stillPresent = new Set<string>();
    for (const m of messages) {
      if (!m.disappear_at || m.disappear_at === "pending") continue;
      stillPresent.add(m.id);
      const existing = scheduled.get(m.id);
      // FIX: now that disappear_at is sender-authoritative-only (see the
      // markRead effect above), it shouldn't change once set — but if an
      // older client, a race, or a future bug ever does deliver a new
      // value for an id we've already scheduled, honor the latest value
      // instead of quietly keeping a stale timer around. Comparing the
      // timestamp string itself (not just id presence) is what makes this
      // self-correcting.
      if (existing) {
        if (existing.at === m.disappear_at) continue;
        clearTimeout(existing.timer);
      }
      const delay = new Date(m.disappear_at).getTime() - Date.now();
      const remove = () => {
        scheduled.delete(m.id);
        setMessages(prev => prev.filter(x => x.id !== m.id));
      };
      if (delay <= 0) { remove(); continue; }
      scheduled.set(m.id, { at: m.disappear_at, timer: setTimeout(remove, delay) });
    }
    // A message could disappear from `messages` for a reason other than
    // expiry (manual delete, chat switch) — clear its timer so it doesn't
    // fire a no-op removal later.
    for (const [id, entry] of scheduled) {
      if (!stillPresent.has(id)) { clearTimeout(entry.timer); scheduled.delete(id); }
    }
  }, [messages]);

  useEffect(() => () => {
    for (const entry of disappearTimersRef.current.values()) clearTimeout(entry.timer);
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

  // ─── Optimistic send helpers ────────────────────────────────────────────
  // Shared by text/image/file/voice sends AND their retries, so "attempt"
  // logic lives in exactly one place per message kind regardless of
  // whether it's firing for the first time or being retried after a
  // failure. Each builds/updates the SAME optimistic bubble already in
  // `messages` (matched by clientId) rather than creating a new one, so a
  // retry doesn't duplicate the message in the timeline.
  type MediaRetryPayload = { kind: "media"; file: File | Blob; msgType: "image" | "file" | "voice"; fileName: string; disappearAt: string | null };
  type TextRetryPayload = { kind: "text"; text: string; replyToId: string | null; isSilent: boolean };

  const attemptSendText = useCallback(async (clientId: string, text: string, replyToId: string | null, isSilent: boolean) => {
    if (!user || !partnerId) return;
    setMessages(prev => prev.map(m => m.id===clientId ? { ...m, _sendStatus: "sending" } : m));
    try {
      const enc = e2eReady ? await encrypt(text) : text;
      const { data: inserted, error } = await supabase.from("messages").insert({
        sender_id:user.id, receiver_id:partnerId, content:enc, message_type:"text",
        reply_to_id:replyToId, disappear_at:disappearMode?"pending":null,
        silent: isSilent,
      } as any).select().single();
      if (error || !inserted) throw error || new Error("insert returned no row");
      // Replace the optimistic bubble in place with the real row — same
      // slot in the timeline, no flicker/reorder. Once this real id is in
      // `messages`, the realtime INSERT that's also about to arrive for
      // this same row is a no-op (handleInsert's own id-based dedup, a few
      // hundred lines up, already skips ids already present).
      setMessages(prev => prev.map(m => m.id===clientId
        ? ({ ...(inserted as any), decryptedContent: text } as DecryptedMessage)
        : m));
      pendingSendPayloads.current.delete(clientId);
    } catch (err) {
      logError("Chat.handleSend", "insert failed", err);
      setMessages(prev => prev.map(m => m.id===clientId ? { ...m, _sendStatus: "failed" } : m));
      pendingSendPayloads.current.set(clientId, { kind: "text", text, replyToId, isSilent });
      toast({ title: "Failed to send", description: "Tap the message to retry.", variant: "destructive" });
    }
  }, [user, partnerId, e2eReady, encrypt, disappearMode, toast]);

  const attemptSendMedia = useCallback(async (
    clientId: string, file: File | Blob, msgType: "image" | "file" | "voice",
    fileName: string, disappearAt: string | null,
  ) => {
    if (!user || !partnerId) return;
    setMessages(prev => prev.map(m => m.id===clientId ? { ...m, _sendStatus: "sending", _uploadProgress: 0 } : m));
    try {
      const objectPath = `${user.id}/${Date.now()}_${fileName}`;
      // resumableUpload (src/lib/resumableUpload.ts) — already used by
      // Gallery — instead of a single-shot storage.upload(): chunks the
      // file, retries each chunk independently with backoff on a flaky
      // connection, can resume, and reports real byte-level progress via
      // onProgress. Chat previously used the plain one-shot upload with
      // none of that, which is the "slow on bad connections, no feedback"
      // gap this whole change addresses.
      const result = await resumableUpload({
        bucket: "chat-files",
        objectPath,
        file,
        contentType: (file as File).type || undefined,
        onProgress: (uploaded, total) => {
          const pct = total > 0 ? Math.round((uploaded / total) * 100) : 0;
          setMessages(prev => prev.map(m => m.id===clientId ? { ...m, _uploadProgress: pct } : m));
        },
      });
      // BUG FIX: this used to set content to a hardcoded "📷 Photo" /
      // "📎 filename" placeholder — stored to the DB AND used as
      // decryptedContent, which MessageBubble renders as a caption line
      // under every media message unconditionally (`msg.decryptedContent
      // && <p>...`, not gated to only real user captions). That's exactly
      // the "photo shows a 📷 Photo emoji+text underneath it" bug. This
      // placeholder also wasn't doing anything useful: push notification
      // body text for photos/files/voice is generated independently
      // server-side in fcm.ts from the message TYPE ("📷 Sent a photo"
      // etc.), never from this content field — so there was no reason to
      // set it at all. Media messages have no caption-input UI yet, so
      // there's no real caption to preserve; content is simply left null,
      // and file_name (already rendered separately, see MessageBubble's
      // message_type==="file" branch) still carries the filename.
      const caption = null;
      const { data: inserted, error } = await supabase.from("messages").insert({
        sender_id:user.id, receiver_id:partnerId, content:caption,
        message_type:msgType, file_url:result.pseudoPublicUrl, file_name:fileName,
        disappear_at:disappearAt,
      } as any).select().single();
      if (error || !inserted) throw error || new Error("insert returned no row");
      // Same signed-URL resolution the read paths already use (see the
      // resolveSignedUrl calls a bit further up this file) — chat-files is
      // a private bucket, so the row's stored file_url isn't directly
      // fetchable; resolve it once here rather than waiting for the next
      // full messages refetch to do it.
      const signedUrl = await resolveSignedUrl("chat-files", result.pseudoPublicUrl);
      setMessages(prev => prev.map(m => {
        if (m.id !== clientId) return m;
        if (m._localPreviewUrl) URL.revokeObjectURL(m._localPreviewUrl);
        return { ...(inserted as any), decryptedContent: caption, file_url: signedUrl } as DecryptedMessage;
      }));
      pendingSendPayloads.current.delete(clientId);
    } catch (err) {
      logError("Chat.sendMedia", `${msgType} send failed`, err);
      setMessages(prev => prev.map(m => m.id===clientId ? { ...m, _sendStatus: "failed", _uploadProgress: undefined } : m));
      pendingSendPayloads.current.set(clientId, { kind: "media", file, msgType, fileName, disappearAt });
      // DIAGNOSTIC IMPROVEMENT: this previously showed only a fixed
      // "Failed to send X" with no reason — every media-send failure
      // looked identical whether it was a network drop, an RLS rejection,
      // a finalize-upload 500, or something else entirely, so diagnosing
      // a real report of this ("error sending photo/file/camera photo")
      // requires either live server logs or guessing. Now surfaces the
      // actual underlying message (storage/RLS errors carry .message;
      // finalize-upload failures come through as EdgeFunctionError with
      // the edge function's own {error: "..."} text already threaded in
      // via parseFunctionErrorBody) so the NEXT failure is something the
      // person can actually screenshot and report precisely.
      const reason = err instanceof Error ? err.message : String(err);
      toast({
        title: `Failed to send ${msgType==="voice"?"voice message":msgType==="image"?"photo":"file"}`,
        description: `${reason}\n\nTap the message to retry.`, variant: "destructive",
      });
    }
  }, [user, partnerId, toast]);

  /** Wired to MessageTimeline's onRetryMessage — tapping a failed bubble
   *  (or its status icon) re-attempts the exact same send. */
  const retryMessage = useCallback((msg: DecryptedMessage) => {
    const payload = pendingSendPayloads.current.get(msg.id) as (TextRetryPayload | MediaRetryPayload | undefined);
    if (!payload) return;
    hapticLight();
    if (payload.kind === "text") attemptSendText(msg.id, payload.text, payload.replyToId, payload.isSilent);
    else attemptSendMedia(msg.id, payload.file, payload.msgType, payload.fileName, payload.disappearAt);
  }, [attemptSendText, attemptSendMedia]);

  const sendVoiceMessage = async (blob: Blob) => {
    if (!user||!partnerId) return;
    const ext = blob.type.includes("webm")?"webm":"m4a";
    const fileName = `voice.${ext}`;
    const clientId = `pending-${crypto.randomUUID()}`;
    const localUrl = URL.createObjectURL(blob);
    const disappearAt = disappearMode?"pending":null;
    setMessages(prev => [...prev, {
      id: clientId, sender_id:user.id, receiver_id:partnerId,
      content: "🎤 Voice message", decryptedContent: "🎤 Voice message",
      message_type:"voice", file_url:null, file_name:fileName,
      created_at: new Date().toISOString(), is_read:false,
      reply_to_id:null, disappear_at:disappearAt,
      _sendStatus:"sending", _uploadProgress:0, _localPreviewUrl:localUrl,
    } as DecryptedMessage]);
    await attemptSendMedia(clientId, blob, "voice", fileName, disappearAt);
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
    hapticMessageSent();
    const loveEmojis = ["❤️","♥️","💕","💖","💗","😍","🥰","💘","💝","🔥","🎉"];
    for (const e of loveEmojis) { if (text.includes(e)) { dispatchEmojiEffect(e); break; } }
    // Optimistic bubble appears the instant Send is tapped — encryption
    // and the network round trip both happen after this, inside
    // attemptSendText, not before the user sees anything.
    const clientId = `pending-${crypto.randomUUID()}`;
    setMessages(prev => [...prev, {
      id: clientId, sender_id:user.id, receiver_id:partnerId,
      content: null, decryptedContent: text,
      message_type:"text", file_url:null, file_name:null,
      created_at: new Date().toISOString(), is_read:false,
      reply_to_id: rep?.id||null, disappear_at:disappearMode?"pending":null,
      _sendStatus: "sending",
    } as DecryptedMessage]);
    try {
      await attemptSendText(clientId, text, rep?.id||null, isSilent);
    } finally {
      sendDedup.release(dedupKey);
    }
  }, [message,user,partnerId,encrypt,e2eReady,replyTo,disappearMode,toast,editingMsg,editText,attemptSendText]);

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
    const clientId = `pending-${crypto.randomUUID()}`;
    const localUrl = URL.createObjectURL(file);
    const disappearAt = disappearMode?"pending":null;
    // BUG FIX: same as attemptSendMedia below — no caption placeholder,
    // see the comment there for why.
    const caption = null;
    // Appears immediately using the local blob — full-resolution, already
    // viewable/scrollable — while the real upload happens in the
    // background via attemptSendMedia below.
    setMessages(prev => [...prev, {
      id: clientId, sender_id:user.id, receiver_id:partnerId,
      content: caption, decryptedContent: caption,
      message_type:type, file_url:null, file_name:file.name,
      created_at: new Date().toISOString(), is_read:false,
      reply_to_id:null, disappear_at:disappearAt,
      _sendStatus:"sending", _uploadProgress:0, _localPreviewUrl:localUrl,
    } as DecryptedMessage]);
    e.target.value = "";
    await attemptSendMedia(clientId, file, type, file.name, disappearAt);
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
    // BUG FIX: clearChat previously only touched `messages` — imported
    // WhatsApp history lives in a separate table (imported_chats) that was
    // never cleared at all, so after "Clear chat" the real messages
    // disappeared but the whole imported transcript stayed visible. Uses
    // an RPC (not a direct .update()) because this needs to hide rows
    // regardless of which partner originally ran the import — see the
    // migration's comment for why a direct owner-scoped update can't do
    // that under this table's existing RLS.
    await supabase.rpc("clear_imported_chats_for_viewer" as any, { p_partner_id: partnerId });
    setMessages([]); setImportedMessages([]); markedReadRef.current = new Set();
    setShowClearDialog(false);
    toast({ title:"Chat cleared", description:"Cleared for you. If your partner has also cleared it, it's gone for good — otherwise you can recover it later." });
  };

  const recoverChat = async () => {
    if (!user||!partnerId) return;
    await supabase.from("messages").update({ deleted_by_sender:false } as any).eq("sender_id",user.id).eq("receiver_id",partnerId);
    await supabase.from("messages").update({ deleted_by_receiver:false } as any).eq("sender_id",partnerId).eq("receiver_id",user.id);
    // BUG FIX: same gap as clearChat above, mirrored for recovery.
    await supabase.rpc("recover_imported_chats_for_viewer" as any, { p_partner_id: partnerId });
    markedReadRef.current = new Set();
    await fetchMessages();
    await fetchImportedMessages();
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

  // Delete is permanent and unrecoverable (unlike Clear Chat, which only
  // hides messages for you). Tapping Delete in the long-press sheet no
  // longer deletes directly — it stages the message and opens a confirm
  // dialog, matching the existing "Clear chat?" confirmation pattern below.
  const requestDeleteMessage = useCallback(() => {
    if (contextMenuMsg) setPendingDeleteMsg(contextMenuMsg);
  }, [contextMenuMsg]);

  const confirmDeleteMessage = useCallback(async () => {
    if (!pendingDeleteMsg || !user) return;
    // FIX BUG-07: Enforce ownership at the query level, not just the UI.
    // The UI passes isMine to MessageContextMenu to conditionally show Delete,
    // but contextMenuMsg state is set on any long-press. Without this eq() the
    // handler would delete any message ID it receives, including the partner's.
    // Adding eq("sender_id", user.id) means the DB will reject deletes on rows
    // the current user doesn't own (even if RLS is misconfigured).
    if (pendingDeleteMsg.sender_id !== user.id) {
      toast({ title:"You can only delete your own messages", variant:"destructive" });
      setPendingDeleteMsg(null);
      return;
    }
    await supabase.from("messages").delete().eq("id",pendingDeleteMsg.id).eq("sender_id",user.id);
    setMessages(prev => prev.filter(m => m.id!==pendingDeleteMsg.id));
    setPendingDeleteMsg(null); toast({ title:"Deleted" });
  }, [pendingDeleteMsg, user, toast]);

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
    setEverConnected(false);
    setCallMode(mode);
    dismissCallOutcome();
    try {
      // Mic permission check — routed through the shared
      // ensureMediaPermission()/PermissionDeniedSheet (same one Gallery
      // and Calls.tsx use) instead of a raw getUserMedia probe with no
      // recovery path on denial. Camera is still left for Daily.co to
      // request itself at join time (unchanged) — probing it here would
      // race PeekGuard/cameraBus for the camera.
      const micGranted = await ensureCallMedia("microphone", () => startCall(mode));
      if (!micGranted) { setIsStartingCall(false); return; }
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
      // Cancellation flow (item 9): cancelStartingCall() may have run while
      // joinCall()/the insert above were still in flight — it can't touch
      // this row itself since it doesn't have the id yet (insertPromise
      // hadn't resolved). Check here instead: if the person already backed
      // out, mark the just-created row 'cancelled' rather than leaving a
      // stale 'in_progress' row that would ring the recipient's CallKit/
      // Telecom UI for a call nobody is on anymore — this is what fires
      // the VoIP "cancel" push (see notify_voip_on_call_end trigger) that
      // ends the ringing UI on every device that already got the incoming
      // push.
      if (callCancelledRef.current) {
        if (callRecord) {
          // cancel_call() (not a raw update) — atomically refuses to
          // cancel if the recipient has already claimed the call in the
          // instant between insert and this check, so a caller backing
          // out can't retroactively kill a call that's actually connecting.
          await supabase.rpc("cancel_call" as any, { _call_id: (callRecord as any).id });
        }
        return;
      }
      if (callRecord) setCurrentCallId((callRecord as any).id);
      toast({ title:mode==="video"?"Video call started 📹":"Voice call started 📞" });
    } catch (err: unknown) {
      // The call never started, so don't hold the caller in the "wait 39
      // seconds" cooldown for an attempt that did nothing — give the slot back.
      callRoomLimiter.refund();
      toast({ title:"Call failed", description: extractErrorMessage(err), variant:"destructive" });
    }

    setIsStartingCall(false);
  };

  // Incoming-call accept/decline now lives in CallContext (acceptIncomingCall/
  // declineIncomingCall) so it works regardless of which page is mounted —
  // see the BUG FIX comment on CallProvider in CallContext.tsx. isAcceptingCall
  // (from useCall()) covers the same "show full-screen call UI immediately"
  // window that isStartingCall covers for outgoing calls — see the render
  // gate below.
  const endCall = async () => {
    if (currentCallId && user) {
      // State-machine fix (item 1): only transition a call that's still
      // actually 'in_progress' to 'completed'. Without this guard, hanging
      // up a call the OTHER party had already cancelled/missed elsewhere
      // (e.g. a stale realtime event on this device) would silently
      // overwrite that terminal state back to 'completed' — corrupting
      // call history and violating the "no terminal state gets
      // clobbered" invariant this audit was asked to enforce.
      await supabase.from("call_history").update({
        status:"completed", duration_seconds:callDuration, ended_at:new Date().toISOString(),
      } as any).eq("id",currentCallId).eq("status","in_progress");
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
  if (callOutcome || callState==="error" || isStartingCall || isAcceptingCall || callState==="joined" || callState==="joining") {
    return (
      <>
        <CallOverlay
          callState={callState} isStartingCall={isStartingCall || isAcceptingCall} callError={callError}
          leaveCall={leaveCall} cancelStartingCall={cancelStartingCall} endCall={endCall}
          remoteVideoRef={remoteVideoRef} localVideoRef={localVideoRef} screenShareRef={screenShareRef}
          isScreenSharing={isScreenSharing} isVideoOn={isVideoOn} isAudioOn={isAudioOn}
          toggleAudio={toggleAudio} toggleVideo={toggleVideo} toggleScreenShare={toggleScreenShare}
          participantCount={participantCount} partnerAvatar={partnerAvatar} partnerName={partnerName}
          callNetworkQuality={callNetworkQuality} callDuration={callDuration}
          showLipReading={showLipReading} setShowLipReading={setShowLipReading}
          everConnected={everConnected} autoAudioFallback={autoAudioFallback}
          outcome={callOutcome}
          onCallAgain={() => { dismissCallOutcome(); startCall(callMode); }}
          onDismissOutcome={dismissCallOutcome}
        />
        {callPermissionSheet}
      </>
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
      {/* IncomingCallOverlay now mounts once in CallProvider (CallContext.tsx)
          so incoming calls ring/vibrate/show on every page, not just Chat. */}

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
      <ChatHeader
        partnerAvatar={partnerAvatar} appIcon={appIcon} appName={appName}
        partnerId={partnerId} partnerName={partnerName}
        disappearMode={disappearMode} disappearMs={disappearMs}
        partnerTyping={partnerTyping} partnerOnline={partnerOnline} e2eReady={e2eReady}
        isStartingCall={isStartingCall} startCall={startCall} navigate={navigate} sendNudge={sendNudge}
        setSearchOpen={setSearchOpen} searchOpen={searchOpen}
        setSearchQuery={setSearchQuery} searchQuery={searchQuery} searchInputRef={searchInputRef}
        searchResults={searchResults} searchIndex={searchIndex} setSearchIndex={setSearchIndex}
        setDisappearMode={setDisappearMode} setShowDisappearSheet={setShowDisappearSheet}
        recoverChat={recoverChat} setShowClearDialog={setShowClearDialog}
        anniversaryDate={appSettings.anniversaryDate}
      />

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
      <MessageTimeline
        messagesContainerRef={messagesContainerRef} messagesEndRef={messagesEndRef}
        hasMoreMessages={hasMoreMessages} loadingMore={loadingMore} loadMoreMessages={loadMoreMessages}
        messagesLoading={messagesLoading} messagesError={messagesError} fetchMessages={fetchMessages}
        groupedTimeline={groupedTimeline} userId={user?.id} messages={messages}
        searchResults={searchResults} searchIndex={searchIndex}
        partnerName={partnerName} partnerAvatar={partnerAvatar} partnerId={partnerId}
        setReplyTo={setReplyTo} inputRef={inputRef} setContextMenuMsg={setContextMenuMsg}
        setViewingPhoto={setViewingPhoto} formatTime={formatTime} allReactions={allReactions}
        mediaVisible={mediaVisible} reactingMsgId={reactingMsgId} setReactingMsgId={setReactingMsgId}
        partnerTyping={partnerTyping} onRetryMessage={retryMessage}
      />

      {/* Attach tray — Phase 2.5: previously a visually unrelated card
          (bg-card/90 + its own border/blur) floating above the composer,
          which read as a separate dropped-in component rather than
          something that emerged FROM the composer. Now built on the same
          .glass-sheet material the input pill uses, anchored bottom-center
          (transform-origin) so the scale-in genuinely reads as the
          composer's own material extending upward, not a new object
          appearing. Timing tightened to spec (open ~200ms, close ~160ms —
          was a single untuned 380/28 spring both ways). Schedule added as
          a 4th contextual item: the feature already existed
          (setShowSchedulePicker) but was only reachable via an undiscoverable
          long-press on the hub button — this is exactly the "appears
          contextually from +" placement the spec calls for, not new
          functionality. */}
      <AnimatePresence>
        {showAttach && !isRecording && (
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.96 }}
            transition={{ type: "spring", stiffness: 500, damping: 32 }}
            style={{ transformOrigin: "bottom center" }}
            className="mx-4 mb-2 glass-sheet rounded-[24px] p-3 flex gap-2">
            {[
              { label: "Photo",    icon: ImageIcon, onClick: async () => { if (await ensureMedia("photos", () => imageInputRef.current?.click())) imageInputRef.current?.click(); } },
              { label: "Camera",   icon: Camera,    onClick: async () => { if (await ensureMedia("camera", () => cameraInputRef.current?.click())) cameraInputRef.current?.click(); } },
              { label: "File",     icon: FileText,  onClick: async () => { if (await ensureMedia("files", () => fileInputRef.current?.click())) fileInputRef.current?.click(); } },
              { label: "Schedule", icon: Timer,     onClick: () => setShowSchedulePicker(true) },
            ].map(({ label, icon: Icon, onClick }) => (
              <button key={label} onClick={() => { hapticLight(); setShowAttach(false); onClick(); }} className="flex flex-col items-center gap-1.5 flex-1 active:scale-95 transition-transform group">
                <span className="h-11 w-11 rounded-full flex items-center justify-center bg-muted group-hover:bg-accent/15 transition-colors">
                  <Icon className="h-5 w-5 text-foreground/70 group-hover:text-accent transition-colors" />
                </span>
                <span className="text-[11px] text-muted-foreground">{label}</span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      <MessageComposer
        replyTo={replyTo} setReplyTo={setReplyTo} partnerName={partnerName} userId={user?.id}
        editingMsg={editingMsg} setEditingMsg={setEditingMsg} setEditText={setEditText} setMessage={setMessage}
        disappearMode={disappearMode} disappearMs={disappearMs}
        setShowDisappearSheet={setShowDisappearSheet} setDisappearMode={setDisappearMode} setDisappearMs={setDisappearMs}
        isRecording={isRecording} recordingTime={recordingTime} formatRecTime={formatRecTime}
        cancelRecording={cancelRecording} stopRecording={stopRecording} startRecording={startRecording}
        showAttach={showAttach} setShowAttach={setShowAttach} inputRef={inputRef} message={message}
        broadcastTyping={broadcastTyping} editText={editText} handleSend={handleSend}
        showGridMenu={showGridMenu} setShowGridMenu={setShowGridMenu} setShowSchedulePicker={setShowSchedulePicker}
      />

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
            <AlertDialogDescription className="text-xs">Messages will be hidden for you and can be recovered later. If your partner has also cleared them, they're deleted for good.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-full text-xs h-8">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { hapticError(); clearChat(); }} className="rounded-full bg-destructive text-destructive-foreground text-xs h-8">Clear</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!pendingDeleteMsg} onOpenChange={(open) => !open && setPendingDeleteMsg(null)}>
        <AlertDialogContent className="rounded-2xl max-w-[320px]">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm font-semibold">Delete message?</AlertDialogTitle>
            <AlertDialogDescription className="text-xs">This can't be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-full text-xs h-8">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { hapticError(); confirmDeleteMessage(); }} className="rounded-full bg-destructive text-destructive-foreground text-xs h-8">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Overlays */}
      <AnimatePresence>{showGridMenu && <GridMenu onClose={() => setShowGridMenu(false)} onScheduledMessage={message.trim() ? () => setShowSchedulePicker(true) : undefined} onLoveLetter={() => setShowLoveLetter(true)} />}</AnimatePresence>
      {/* Phase 2.5, section 13: was a plain fade-in/out (thumbnail → new
          black page) — the spec explicitly calls this out as wrong
          ("the user should feel that the same image expanded, not fade
          out → new page"). PhotoViewer now takes the message id and
          shares a layoutId with the tapped thumbnail in MessageBubble, so
          Framer Motion animates the actual rect from bubble-thumbnail to
          fullscreen instead of two independent fades. */}
      <AnimatePresence>{viewingPhoto && <PhotoViewer src={viewingPhoto.url} photoId={viewingPhoto.id} onClose={() => setViewingPhoto(null)} />}</AnimatePresence>
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
        onDelete={requestDeleteMessage}
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

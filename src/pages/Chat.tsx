import { motion, AnimatePresence } from "framer-motion";
import {
  ImageIcon, FileText, Camera, Timer, Ghost, PhoneOff,
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
import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useTheme } from "@/contexts/ThemeContext";
import { useDockCompactReporter } from "@/hooks/useDockCompact";
import { useComposerHost, useBottomSurfaceHeight } from "@/contexts/BottomSurfaceContext";
import { resolveWallpaperStyle } from "@/lib/wallpapers";
import { supabase } from "@/integrations/supabase/client";
import { playMessageSound, playCallSound } from "@/lib/sounds";
import { hapticLight, hapticMedium, hapticError, hapticMessageSent } from "@/lib/haptics";
import { useMediaPermission } from "@/components/PermissionDeniedSheet";
import { invalidateNativeMicGrantCache } from "@/lib/mediaPermissions";
import { classifyCallError } from "@/lib/callErrors";
import { useCallOutcome } from "@/hooks/useCallOutcome";
import { useAuth } from "@/hooks/useAuth";
import { useE2E } from "@/hooks/useE2E";
import storage from "@/lib/storage";
import { useCall } from "@/contexts/CallContext";
import { useToast } from "@/hooks/use-toast";
import { invokeEdgeFunction } from "@/lib/edgeFunction";
import { withTimeout } from "@/lib/withTimeout";
import { extractErrorMessage } from "@/lib/errorMessage";
import { resolveSignedUrl } from "@/lib/signedStorageUrl";
import { resumableUpload } from "@/lib/resumableUpload";
import { savePendingMedia, deletePendingMedia, listPendingMedia, purgeStalePendingMedia } from "@/lib/pendingSendQueue";
import { logError, logWarn } from "@/lib/telemetry";
import { callRoomLimiter, scheduledMsgLimiter, formatRetryDelay } from "@/lib/rateLimit";
import { useReconnectRefetch, createSendDedup } from "@/lib/networkState";
import { useKeyboardOpen } from "@/hooks/useKeyboardOpen";
import { useActiveChatPresence } from "@/hooks/useActiveChatPresence";
import { useChatSurprise } from "@/hooks/useChatSurprise";
import type { Message, DecryptedMessage, CallEntry, ImportedMessage, TimelineItem } from "@/types/chat";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

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
  const {
    surprises, stageById: surpriseStageById, surprise: activeSurprise,
    visible: surpriseVisible, openSurprise, close: closeSurprise,
  } = useChatSurprise();
  // WA-01 FIX: imported WhatsApp messages state
  const [importedMessages, setImportedMessages] = useState<ImportedMessage[]>([]);
  const [showClearDialog, setShowClearDialog] = useState(false);
  const [showAttach, setShowAttach]     = useState(false);
  const [showGridMenu, setShowGridMenu] = useState(false);
  const [viewingPhoto, setViewingPhoto] = useState<{ url: string; id: string } | null>(null);
  const [partnerId, setPartnerId]       = useState<string|null>(null);
  const [partnerName, setPartnerName]   = useState("");
  const [partnerAvatar, setPartnerAvatar] = useState<string|null>(null);
  // Push-suppression heartbeat: only live while this screen is genuinely
  // visible with a resolved partner — see useActiveChatPresence's own doc
  // comment for why "mounted" alone isn't the right condition.
  useActiveChatPresence(partnerId);
  const [replyTo, setReplyTo]           = useState<DecryptedMessage|null>(null);
  // ─── Optimistic sending ───────────────────────────────────────────────────
  // Retry payloads for messages currently shown with _sendStatus "failed" —
  // keyed by the optimistic message's clientId (its temporary `id` while
  // pending). Only ever holds entries for messages the user could still
  // retry; cleared the moment a retry succeeds or the message is removed.
  // A ref (not state) since it's never itself rendered — only read/written
  // from inside send/retry handlers.
  // Typed as the retry-payload union the two attempt* callbacks actually
  // store — it was previously Map<string, () => Promise<void>> (a leftover
  // from an older retry design), which both lied about the contents and
  // made every .set() call a type error.
  const pendingSendPayloads = useRef(new Map<string, TextRetryPayload | MediaRetryPayload>());
  // Vanish Mode: on/off only — no duration. Messages sent while it's on
  // stay visible for as long as it stays on; turning it off hard-deletes
  // every vanish message for both people (see endVanishMode below).
  const [disappearMode, setDisappearMode] = useState(false);
  const [showEndVanishConfirm, setShowEndVanishConfirm] = useState(false);
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
  const inputRef        = useRef<HTMLTextAreaElement>(null);
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
  const composerHostEl = useComposerHost();
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
    activeCallId: currentCallId, setActiveCallId: setCurrentCallId, isAcceptingCall, cancelAcceptingCall,
    isCallMinimized, setIsCallMinimized, setActiveCallType,
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
    return Promise.all(msgs.map(async msg => {
      try {
        return {
          ...msg,
          // FIX: also decrypt "letter" type messages
          decryptedContent: (msg.message_type==="text" || msg.message_type==="letter")
            ? await decrypt(msg.content)
            : msg.content,
          // BUG FIX: file_url was stored as a getPublicUrl() output against the
          // private "chat-files" bucket, which 403s — every image/voice/file
          // attachment rendered broken. Resolve to a real signed URL here.
          // resolveSignedUrl returns null on failure (not a broken pseudoPublicUrl)
          // so file_url falls back to the raw DB value — message still renders.
          file_url: msg.file_url ? (await resolveSignedUrl("chat-files", msg.file_url)) ?? msg.file_url : msg.file_url,
        };
      } catch {
        // Per-message error isolation: a signing/decryption failure for one
        // message must not prevent the rest of the conversation from loading.
        return {
          ...msg,
          decryptedContent: msg.content,
        } as DecryptedMessage;
      }
    }));
  }, [decrypt]);

  // ─── Fetch partner ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!user) return;
    supabase.from("profiles").select("partner_id,pet_name").eq("user_id",user.id).single()
      .then(({ data }) => {
        if (data?.partner_id) {
          setPartnerId(data.partner_id);
          const myPetNameForPartner = data.pet_name;
          supabase.from("profiles").select("display_name,avatar_url").eq("user_id",data.partner_id).single()
            .then(({ data: pp }) => {
              if (pp) { setPartnerName(myPetNameForPartner||pp.display_name||"Partner"); setPartnerAvatar(pp.avatar_url); }
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
        // FIX: preserve in-flight optimistic messages (still uploading) so
        // fetchMessages/reconnect doesn't wipe them — BUT drop any optimistic
        // message whose real server counterpart is already in the decrypted list
        // (same sender+receiver+type+content), otherwise we get duplicates with
        // stale _sendStatus "sending" or "failed".
        setMessages(prev => {
          const optimistic = prev.filter(m => {
            if (!m.id.startsWith("pending-") && m._sendStatus !== "sending" && m._sendStatus !== "failed") return false;
            // Check if server already has this message (real UUID, not pending-*)
            const hasServerCopy = decrypted.some(s =>
              s.id !== m.id &&
              s.sender_id === m.sender_id &&
              s.receiver_id === m.receiver_id &&
              s.message_type === m.message_type &&
              s.content === m.content
            );
            if (hasServerCopy) return false; // drop stale optimistic — server version wins
            return true;
          });
          return optimistic.length > 0 ? [...decrypted, ...optimistic] : decrypted;
        });
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
      let dm: DecryptedMessage;
      let decrypted: string | null = null;
      try {
        decrypted = (msg.message_type==="text"||msg.message_type==="letter")
          ? await decrypt(msg.content) : msg.content;
        // resolveSignedUrl returns null on failure — fall back to raw file_url
        const resolvedFileUrl = msg.file_url ? (await resolveSignedUrl("chat-files", msg.file_url)) ?? msg.file_url : msg.file_url;
        dm = { ...msg, decryptedContent: decrypted, file_url: resolvedFileUrl };
      } catch {
        // Per-message error isolation: signing/decryption failure must not
        // prevent the message from appearing in the chat.
        dm = { ...msg, decryptedContent: msg.content } as DecryptedMessage;
      }
      // FIX: guard against a message already present from the initial fetchMessages()
      // load (or a realtime reconnect replay) being appended a second time — seenIds
      // above only dedupes the two postgres_changes listeners on this channel, not
      // against messages already in state.
      // Also dedup against optimistic messages that may still have a different ID
      // ("pending-xxx" vs the real UUID) but represent the same logical message.
      setMessages(prev => {
        if (prev.some(m => m.id === dm.id)) return prev;
        // Check for an optimistic bubble with a pending ID that matches
        const hasOptimisticTwin = prev.some(m =>
          m.id.startsWith("pending-") &&
          m.sender_id === dm.sender_id &&
          m.receiver_id === dm.receiver_id &&
          m.message_type === dm.message_type &&
          m.content === dm.content
        );
        if (hasOptimisticTwin) return prev; // server version will be picked up by fetchMessages
        return [...prev, dm];
      });
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
      if (messages.length===0 && callHistory.length===0 && importedMessages.length===0 && surprises.length===0) return;
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
  }, [messages.length, callHistory.length, importedMessages.length, surprises.length]);

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
      disappear_at:disappearMode?"vanish":null,
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
      message_type:"letter", disappear_at:disappearMode?"vanish":null,
    });
    if (error) toast({ title:"Failed to send letter", variant:"destructive" });
    else toast({ title:"Letter delivered 💌" });
  }, [user,partnerId,encrypt,e2eReady,disappearMode,toast]);

  // ─── Mark read ─────────────────────────────────────────────────────────
  // Vanish Mode redesign: disappearing messages no longer resolve a
  // "pending" sentinel into a real expiry timestamp — sent-while-vanish
  // messages carry disappear_at="vanish" permanently until the mode is
  // turned off (endVanishMode hard-deletes them then). The old sender-side
  // "resolve pending -> real timestamp" step that used to live here is
  // gone entirely along with the per-message timer it fed.
  useEffect(() => {
    if (!user||!partnerId) return;
    // Mark received messages as read.
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

  // Vanish Mode: no per-message timer anymore — a vanish message stays
  // visible for as long as the mode itself stays on. Turning the mode off
  // is the only thing that removes them, and it does so immediately via a
  // real DELETE (see endVanishMode below), not a scheduled local removal.
  const endVanishMode = useCallback(async () => {
    if (!user || !partnerId) { setDisappearMode(false); setShowEndVanishConfirm(false); return; }
    hapticMedium();
    // Hard delete, not a soft/local removal — every message either of us
    // sent in this conversation while Vanish Mode was on, for both sides.
    // RLS already lets a user delete rows where they're sender OR
    // receiver, so this single call clears the partner's copy too; the
    // realtime DELETE listener above removes it from their open chat the
    // same instant, and nothing is left in the database afterward.
    const { error } = await supabase.from("messages").delete()
      .eq("disappear_at", "vanish")
      .or(`and(sender_id.eq.${user.id},receiver_id.eq.${partnerId}),and(sender_id.eq.${partnerId},receiver_id.eq.${user.id})`);
    if (error) {
      logError("Chat.endVanishMode", "bulk delete failed", error);
      toast({ title: "Couldn't clear vanish messages", description: "Some may remain — try again.", variant: "destructive" });
    }
    setMessages(prev => prev.filter(m => m.disappear_at !== "vanish"));
    setDisappearMode(false);
    setShowEndVanishConfirm(false);
  }, [user, partnerId, toast]);

  const toggleVanishMode = useCallback(() => {
    if (disappearMode) {
      setShowEndVanishConfirm(true); // destructive — confirm before deleting
    } else {
      hapticMedium();
      setDisappearMode(true);
    }
  }, [disappearMode]);

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

  // ROOT-CAUSE FIX (call brief §11 — call + voice recording interaction):
  // nothing anywhere tied an in-progress recording to callState. Chat.tsx's
  // own render early-returns to <CallOverlay/> once callState hits
  // "joining"/"joined" (see the return near the bottom of this component),
  // but that's a JSX swap on the SAME mounted fiber — isRecording and
  // mediaRecorderRef survive untouched underneath it, invisible to the
  // user (no timer, no cancel/stop button reachable) while joinCall()
  // simultaneously requests its OWN getUserMedia audio track for the call.
  // Two concurrent mic claims from the same page is unreliable at best
  // (echo/contention) and on native — where CallKit/Telecom can force the
  // OS audio session over to the call — the recording's track can be
  // killed out from under it mid-capture with nothing here noticing, so
  // resuming the composer after the call showed a still-"recording" timer
  // counting through the entire call and a Send that would ship whatever
  // survived: silence, a truncated clip, or nothing. Cancelling outright
  // (not attempting a pause/resume MediaRecorder doesn't reliably support
  // across this app's native targets anyway) is the honest, safe choice —
  // matches the brief's own "do not corrupt the audio file" instruction
  // better than sending a file that spans a call would.
  useEffect(() => {
    if ((callState === "joining" || callState === "joined") && isRecording) {
      cancelRecording();
      toast({ title: "Recording cancelled", description: "A call interrupted your voice message." });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cancelRecording is a plain function recreated every render; only callState should trigger this
  }, [callState]);

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
        reply_to_id:replyToId, disappear_at:disappearMode?"vanish":null,
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
    // RELOAD-RESILIENCE FIX: persist the raw bytes to IndexedDB now, before
    // the upload starts — not just the "sending" status. See
    // pendingSendQueue.ts's own top-of-file comment for the full root
    // cause; short version: without this, a reload mid-upload (or after a
    // failure but before the user retried) made the message disappear
    // completely, with no trace and no way to retry, even though the
    // chunks that DID make it up were still sitting server-side. Awaited
    // (not fire-and-forget) so the entry is actually on disk before the
    // network upload below gets a chance to start — a rehydrate-on-mount
    // pass with no persisted bytes to resume from would be pointless.
    // contentType mirrors what resumableUpload itself falls back to a few
    // lines down, so a rehydrated retry chunks/uploads identically to the
    // original attempt.
    await savePendingMedia({
      clientId, partnerId, msgType, fileName,
      contentType: (file as File).type || "application/octet-stream",
      disappearAt, blob: file, createdAt: Date.now(),
    });
    try {
      // ROOT-CAUSE FIX (retry integrity + "Missing chunk" class failures):
      // objectPath used to be regenerated on EVERY attempt as
      // `${Date.now()}_${fileName}`, which meant each retry abandoned the
      // previous attempt's pending_uploads row and any chunks already
      // uploaded under the old path — orphaned server-side garbage, a
      // tracking row finalize-upload would later 404 against, and zero
      // resume benefit. Deriving the path from the message's stable
      // clientId instead makes a retry RESUME the same upload: same
      // tracking row, same chunk dir, already-present chunks skipped by
      // resumableUpload's resume scan. It also removes a second latent
      // bug: two attachments sent within the same millisecond used to
      // collide onto one objectPath (clientIds are UUIDs — no collision).
      const objectPath = `${user.id}/${clientId.replace(/^pending-/, "")}_${fileName}`;
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
      // INSTANT SWAP: replace optimistic bubble with real DB row immediately.
      // CRITICAL: carry _localPreviewUrl from the optimistic bubble — the DB
      // row (inserted) does NOT have this field, so spreading inserted alone
      // would lose the blob preview and mediaSrc would become null.
      // Also target the background resolver at inserted.id (real UUID), not
      // clientId (pending-xxx) — the message ID has changed after the swap.
      const realId = (inserted as any).id as string;
      setMessages(prev => prev.map(m => {
        if (m.id !== clientId) return m;
        return {
          ...(inserted as any),
          decryptedContent: caption,
          file_url: null,
          // Preserve local blob preview — lost when spreading DB row
          _localPreviewUrl: m._localPreviewUrl,
          // Clear sending status — message is now in DB
          _sendStatus: undefined,
          _uploadProgress: undefined,
        } as DecryptedMessage;
      }));
      pendingSendPayloads.current.delete(clientId);
      // Upload genuinely succeeded and is now a real row — the persisted
      // bytes have served their purpose (resuming across a reload that
      // never happened), safe to drop now.
      deletePendingMedia(clientId);
      // Resolve signed URL in background — the bubble already shows the
      // local preview, so this is purely for the URL to become fetchable
      // (for full-res view, download, etc.).
      // CRITICAL: only revoke the local preview blob and update file_url
      // if we got a REAL signed URL back. If resolveSignedUrl fell back to
      // the raw pseudoPublicUrl (private bucket → 403), keep the blob
      // URL so the media keeps displaying.
      // Use realId (the DB UUID) — not clientId (the old pending-xxx ID).
      resolveSignedUrl("chat-files", result.pseudoPublicUrl).then(signedUrl => {
        if (signedUrl && signedUrl.includes("/object/sign/")) {
          // Got a real signed URL — use it and revoke the local blob
          setMessages(prev => prev.map(m => {
            if (m.id !== realId) return m;
            if (m._localPreviewUrl) URL.revokeObjectURL(m._localPreviewUrl);
            return { ...m, file_url: signedUrl, _localPreviewUrl: undefined } as DecryptedMessage;
          }));
        }
        // else: signing failed (null) — keep file_url as null
        // so mediaSrc falls back to _localPreviewUrl (blob preview still works)
      }).catch(() => {});
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logError("Chat.sendMedia", `${msgType} send failed: ${errMsg}`, err);
      setMessages(prev => prev.map(m => m.id===clientId ? { ...m, _sendStatus: "failed", _uploadProgress: undefined } : m));
      pendingSendPayloads.current.set(clientId, { kind: "media", file, msgType, fileName, disappearAt });
      // Surface a concise retry-friendly toast — include the specific
      // failure reason so the user can report it precisely if retry also fails.
      const brief = errMsg.length > 80 ? errMsg.slice(0, 80) + "…" : errMsg;
      toast({
        title: `Failed to send ${msgType==="voice"?"voice message":msgType==="image"?"photo":"file"}`,
        description: brief || "Tap the failed message to retry.", variant: "destructive",
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
    // FIRE-AND-FORGET: retry uploads run in background, optimistic bubble
    // already shows progress ring
  }, [attemptSendText, attemptSendMedia]);

  // RELOAD-RESILIENCE: rehydrate any photo/file/voice send that was still
  // in flight (or had failed but not yet been retried) the last time this
  // conversation was open, from the persisted bytes in IndexedDB — see
  // pendingSendQueue.ts's top-of-file comment for the full root cause.
  // Runs once user+partnerId are known. Re-creates the exact same
  // optimistic bubble handleFileSelect/sendVoiceMessage would have shown
  // originally (same clientId, so retryMessage's tap-to-retry keeps
  // working on it identically to any other failed message), then
  // immediately re-attempts the send — resumableUpload's own resume logic
  // means chunks that made it up before the reload are skipped, not
  // re-uploaded, so this genuinely continues the upload rather than
  // restarting it.
  useEffect(() => {
    if (!user || !partnerId) return;
    let cancelled = false;
    (async () => {
      await purgeStalePendingMedia();
      const pending = await listPendingMedia(partnerId);
      if (cancelled || pending.length === 0) return;
      for (const entry of pending) {
        const localUrl = URL.createObjectURL(entry.blob);
        setMessages(prev => {
          // Guard against double-rehydration (e.g. React StrictMode's
          // double-invoke in dev, or this effect re-running if partnerId
          // ever changes) — never insert the same clientId twice.
          if (prev.some(m => m.id === entry.clientId)) return prev;
          return [...prev, {
            id: entry.clientId, sender_id: user.id, receiver_id: partnerId,
            content: null, decryptedContent: null,
            message_type: entry.msgType, file_url: null, file_name: entry.fileName,
            created_at: new Date(entry.createdAt).toISOString(), is_read: false,
            reply_to_id: null, disappear_at: entry.disappearAt,
            _sendStatus: "sending", _uploadProgress: 0, _localPreviewUrl: localUrl,
          } as DecryptedMessage];
        });
        pendingSendPayloads.current.set(entry.clientId, {
          kind: "media", file: entry.blob, msgType: entry.msgType,
          fileName: entry.fileName, disappearAt: entry.disappearAt,
        });
        attemptSendMedia(entry.clientId, entry.blob, entry.msgType, entry.fileName, entry.disappearAt)
          .catch(() => {}); // error handled inside attemptSendMedia, same as every other send path
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- attemptSendMedia is stable (useCallback); only user/partnerId should re-trigger this
  }, [user, partnerId]);

  const sendVoiceMessage = async (blob: Blob) => {
    if (!user||!partnerId) return;
    const ext = blob.type.includes("webm")?"webm":"m4a";
    const fileName = `voice.${ext}`;
    const clientId = `pending-${crypto.randomUUID()}`;
    const localUrl = URL.createObjectURL(blob);
    const disappearAt = disappearMode?"vanish":null;
    setMessages(prev => [...prev, {
      id: clientId, sender_id:user.id, receiver_id:partnerId,
      content: "🎤 Voice message", decryptedContent: "🎤 Voice message",
      message_type:"voice", file_url:null, file_name:fileName,
      created_at: new Date().toISOString(), is_read:false,
      reply_to_id:null, disappear_at:disappearAt,
      _sendStatus:"sending", _uploadProgress:0, _localPreviewUrl:localUrl,
    } as DecryptedMessage]);
    // FIRE-AND-FORGET: don't await — the upload runs in background while
    // the UI already shows the optimistic bubble with progress ring.
    // This makes voice send feel instant: mic button resets immediately,
    // bubble appears instantly, upload progresses in background.
    attemptSendMedia(clientId, blob, "voice", fileName, disappearAt)
      .catch(() => {}); // error handled inside attemptSendMedia
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
      reply_to_id: rep?.id||null, disappear_at:disappearMode?"vanish":null,
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
    // BUG FIX (silent failure): this insert's result was never checked —
    // unlike every other send path in this file (handleSend, handleSendLoveLetter,
    // handleSendScheduled all check `error` and toast on failure), a failed
    // nudge insert produced no feedback at all. The haptic + heart animation
    // above fire optimistically and are correct to do so (a nudge should feel
    // instant), but that's exactly why the send itself needs its own honest
    // failure path — otherwise a failed nudge is indistinguishable from a
    // successful one to the person sending it.
    const { error } = await supabase.from("messages").insert({
      sender_id:user.id, receiver_id:partnerId, content:"❤️",
      message_type:"nudge", disappear_at:null,
    });
    if (error) toast({ title:"Nudge didn't go through", variant:"destructive" });
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
    const disappearAt = disappearMode?"vanish":null;
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
    // FIRE-AND-FORGET: upload runs in background while optimistic bubble
    // with local preview + progress ring is already visible
    attemptSendMedia(clientId, file, type, file.name, disappearAt)
      .catch(() => {}); // error handled inside attemptSendMedia
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
    setActiveCallType(mode);
    dismissCallOutcome();

    // STUCK-FOREVER SAFETY NET (see Calls.tsx's startCall for the full
    // reasoning): the pre-join phase below — busy check, mic permission,
    // room creation, call_history insert — has no other watchdog covering
    // it as a whole. This is a last-resort backstop so a hang anywhere in
    // it can't leave the call screen on "Connecting…" forever. Cleared as
    // soon as we're safely past it (roomPromise/joinCall's own watchdog
    // take over from there); only fires if something got stuck.
    const preJoinWatchdog = setTimeout(() => {
      if (callCancelledRef.current) return;
      callCancelledRef.current = true;
      setIsStartingCall(false);
      callRoomLimiter.refund();
      toast({ title: "Call failed", description: "That took too long to start. Check your connection and try again.", variant: "destructive" });
    }, 40_000);

    // LATENCY FIX (same reasoning as Calls.tsx's startCall): the busy
    // check, the mic-permission prompt, and room creation don't depend on
    // each other's result to start — is_partner_on_call only needs
    // partnerId, create-and-token only needs user.id, and the permission
    // prompt needs neither. They used to run one after another, stacking
    // three round trips in front of joinCall(); firing them together lets
    // the latencies overlap instead.
    // STUCK-FOREVER FIX: raw `supabase.rpc()` has no timeout of its own —
    // a stalled fetch here would never hit the .catch() below (that only
    // handles a REJECTION, not a promise that simply never settles), and
    // since this is `await`ed before anything else, the call would never
    // progress past "Connecting…". withTimeout bounds it to 8s; this
    // check is advisory only, so timing out is treated the same as any
    // other failure.
    const busyCheckPromise = withTimeout(
      supabase.rpc("is_partner_on_call" as never, { p_partner_id: partnerId } as never),
      8_000, "Partner busy check",
    ).catch(() => ({ data: null as boolean | null }));
    const roomPromise = invokeEdgeFunction<{ name: string; url: string; token: string }>("daily-call",
      { body: { action: "create-and-token", roomName: `duo-${user.id.slice(0, 8)}-${Date.now()}` }, timeoutMs: 25_000 });
    // Avoids an unhandled-rejection warning while we're still awaiting the
    // busy check / mic permission below — the real error, if any, is
    // still surfaced when roomPromise is actually awaited further down.
    roomPromise.catch(() => {});
    const discardRoom = () => {
      roomPromise.then((d) => {
        invokeEdgeFunction("daily-call", { body: { action: "delete-room", roomName: d.name } }).catch(() => {});
      }).catch(() => {});
    };

    // HONEST BUSY PRE-CHECK (same as Calls.tsx): if the partner is already
    // on a DuoSpace call, say so now instead of ringing a phone that can't
    // answer. Advisory — failures never block the call attempt.
    const { data: partnerBusy } = await busyCheckPromise;
    if (partnerBusy === true) {
      clearTimeout(preJoinWatchdog);
      setIsStartingCall(false);
      discardRoom();
      toast({ title: "Partner is on a call", description: "They're currently on another DuoSpace call. Try again in a few minutes." });
      return;
    }
    try {
      // Mic permission check — routed through the shared
      // ensureMediaPermission()/PermissionDeniedSheet (same one Gallery
      // and Calls.tsx use) instead of a raw getUserMedia probe with no
      // recovery path on denial. Camera is still left for Daily.co to
      // request itself at join time (unchanged) — probing it here would
      // race PeekGuard/cameraBus for the camera.
      const micGranted = await ensureCallMedia("microphone", () => startCall(mode));
      if (!micGranted) { clearTimeout(preJoinWatchdog); setIsStartingCall(false); discardRoom(); return; }
      // From here on, roomPromise (25s timeout) and joinCall()'s own join
      // watchdog (useDailyCall.ts, 25s) between them cover the rest of the
      // path to "joined" — the pre-join watchdog's job (guarding the
      // otherwise-unbounded busy-check/mic-permission window above) is done.
      clearTimeout(preJoinWatchdog);
      playCallSound();
      // BUG FIX (call latency): "create-and-token" does both Daily API
      // calls server-side in one edge-function invocation instead of two
      // fully sequential client round trips (create-room, then only after
      // that resolves, get-token) — see the edge function for details.
      // It's now also kicked off at the very top of this function (see
      // roomPromise above) instead of only after the mic prompt resolves,
      // so by the time we get here it has often already finished.
      // CONNECT-RELIABILITY FIX: 25s covers the edge-function cold-start path
      // (two Daily REST calls + key resolution server-side) that the 15s
      // default surfaced as "unable to connect".
      const data = await roomPromise;

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
      // Defensive: normally already cleared right after mic permission
      // resolves above, but a throw from ensureCallMedia itself (rather
      // than it returning false) would skip that — clear here too so the
      // watchdog can't fire 40s after a failure the person already saw.
      clearTimeout(preJoinWatchdog);
      // The call never started, so don't hold the caller in the "wait 39
      // seconds" cooldown for an attempt that did nothing — give the slot back.
      callRoomLimiter.refund();
      // Keep the native mic-grant cache (mediaPermissions.ts) honest: if
      // this failure was actually a (now-stale) permission denial, don't
      // let a future call start skip the probe on the strength of a grant
      // that no longer holds.
      if (classifyCallError(err).code === "PERMISSION_DENIED") invalidateNativeMicGrantCache();
      toast({ title:"Call failed", description: extractErrorMessage(err), variant:"destructive" });
    }

    clearTimeout(preJoinWatchdog);
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
  // PERF: this merges/sorts/date-groups every message, call, import, and
  // surprise in the conversation — was previously recomputed from scratch on
  // *every* render (composer keystrokes, typing-indicator flicker, search
  // index changes, reaction-picker open/close, etc.), which is what made
  // long conversations feel laggy while scrolling/typing. Memoized on the
  // four source arrays so it only re-runs when the actual timeline content
  // changes — output is identical, just computed far less often.
  const groupedTimeline = useMemo(() => {
    const timeline: TimelineItem[] = [
      ...messages.map(m=>({ type:"message" as const, data:m })),
      ...callHistory.map(c=>({ type:"call" as const, data:c })),
      // WA-01 FIX: merge imported WhatsApp messages into the timeline,
      // sorted by their original_timestamp so they appear at the correct
      // historical position relative to real messages.
      ...importedMessages.map(i=>({ type:"imported" as const, data:i })),
      // Surprise 2.0 phase 1: a surprise is now a real timeline row (both
      // directions — see fetchSurprisesForConversation), not a global overlay
      // that pops itself open. Sorted into position below like everything else.
      ...surprises.map(s=>({ type:"surprise" as const, data:s })),
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

    const grouped: { date:string; items:TimelineItem[] }[] = [];
    timeline.forEach(item => {
      // WA-01 FIX: use original_timestamp for imported items so date headers
      // reflect the historical date, not the import date
      const rawDate = item.type === "imported"
        ? (item.data as ImportedMessage).original_timestamp
        : item.data.created_at;
      const date = new Date(rawDate).toLocaleDateString(undefined,{ weekday:"short", month:"short", day:"numeric", year:"numeric" });
      const last = grouped[grouped.length-1];
      if (last?.date===date) last.items.push(item);
      else grouped.push({ date, items:[item] });
    });
    return grouped;
  }, [messages, callHistory, importedMessages, surprises]);

  const bottomInset = useBottomSurfaceHeight();
  const attachActions = [
    { label: "Photo",    icon: ImageIcon, onClick: async () => { if (await ensureMedia("photos", () => imageInputRef.current?.click())) imageInputRef.current?.click(); } },
    { label: "Camera",   icon: Camera,    onClick: async () => { if (await ensureMedia("camera", () => cameraInputRef.current?.click())) cameraInputRef.current?.click(); } },
    { label: "File",     icon: FileText,  onClick: async () => { if (await ensureMedia("files", () => fileInputRef.current?.click())) fileInputRef.current?.click(); } },
    { label: "Schedule", icon: Timer,     onClick: () => setShowSchedulePicker(true) },
  ];

  // ─── In-call overlay ──────────────────────────────────────────────────────
  const isCallActive = !!(callOutcome || callState==="error" || isStartingCall || isAcceptingCall || callState==="joined" || callState==="joining");
  if (isCallActive && !isCallMinimized) {
    return (
      <motion.div
        key="call-overlay"
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.97 }}
        transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
        className="h-full"
      >
        <CallOverlay
          callState={callState} isStartingCall={isStartingCall} callError={callError}
          leaveCall={leaveCall} cancelStartingCall={cancelStartingCall} endCall={endCall}
          isAcceptingCall={isAcceptingCall}
          callMode={callMode} partnerAvatar={partnerAvatar} partnerName={partnerName}
          showLipReading={showLipReading} setShowLipReading={setShowLipReading}
          everConnected={everConnected}
          outcome={callOutcome}
          onCallAgain={() => { dismissCallOutcome(); startCall(callMode); }}
          onDismissOutcome={dismissCallOutcome}
        />
        {callPermissionSheet}
      </motion.div>
    );
  }

  const rootWallpaperCss = chatWallpaper ? resolveWallpaperStyle(chatWallpaper, colorMode) : null;
  // Vanish Mode redesign: while active, the whole chat surface switches to
  // its own dark theme (like Instagram's Vanish Mode) instead of dimming
  // whatever wallpaper/theme was already active — see the .vanish-mode
  // CSS-variable block in index.css, which re-themes every semantic
  // Tailwind token (bg-background, bg-card, border-border, etc.) that the
  // rest of this screen already uses, so no per-component styling was
  // needed to make the whole tree go dark.
  const rootBackgroundStyle = !disappearMode && rootWallpaperCss ? { background: rootWallpaperCss } : undefined;

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
    <div className={`flex flex-col h-full bg-background overflow-hidden transition-colors duration-300 ${disappearMode ? "vanish-mode" : ""}`} style={rootBackgroundStyle}>
      <ChatSurpriseHost surprise={activeSurprise} visible={surpriseVisible} close={closeSurprise} />
      {/* Minimized-call banner — shown instead of the full-screen CallOverlay
          when isCallMinimized is true (tapped via that screen's own
          minimize button). Tap the pill to restore the full call screen;
          the small end button stays available without restoring first.
          isCallMinimized is shared via CallContext, so this banner (and
          Calls.tsx's own equivalent) both react to a minimize triggered
          from either call entry point. */}
      <AnimatePresence>
        {isCallActive && isCallMinimized && (
          <motion.button
            type="button"
            initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }}
            onClick={() => { hapticLight(); setIsCallMinimized(false); }}
            className="fixed left-1/2 -translate-x-1/2 z-[90] flex items-center gap-2.5 pl-3 pr-2 py-2 rounded-full glass-sheet shadow-lg"
            style={{ top: "calc(env(safe-area-inset-top, 0px) + 10px)" }}
          >
            <span className="h-2 w-2 rounded-full bg-success animate-pulse" aria-hidden="true" />
            <span className="text-xs font-medium text-foreground">
              {partnerName || "Call"} · {(() => { const m = Math.floor(callDuration / 60), s = callDuration % 60; return `${m}:${String(s).padStart(2, "0")}`; })()}
            </span>
            <span
              role="button" tabIndex={0} aria-label="End call"
              onClick={(e) => { e.stopPropagation(); hapticMedium(); if (isAcceptingCall) cancelAcceptingCall(); else if (callState === "idle") cancelStartingCall(); else endCall(); }}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); e.preventDefault(); if (isAcceptingCall) cancelAcceptingCall(); else if (callState === "idle") cancelStartingCall(); else endCall(); } }}
              className="h-6 w-6 rounded-full bg-destructive flex items-center justify-center shrink-0">
              <PhoneOff className="h-3 w-3 text-destructive-foreground" aria-hidden="true" />
            </span>
          </motion.button>
        )}
      </AnimatePresence>
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
      {/* Header */}
      <ChatHeader
        partnerAvatar={partnerAvatar} appIcon={appIcon} appName={appName}
        partnerId={partnerId} partnerName={partnerName}
        disappearMode={disappearMode}
        partnerTyping={partnerTyping} partnerOnline={partnerOnline} e2eReady={e2eReady}
        isStartingCall={isStartingCall} startCall={startCall} navigate={navigate} sendNudge={sendNudge}
        setSearchOpen={setSearchOpen} searchOpen={searchOpen}
        setSearchQuery={setSearchQuery} searchQuery={searchQuery} searchInputRef={searchInputRef}
        searchResults={searchResults} searchIndex={searchIndex} setSearchIndex={setSearchIndex}
        onToggleDisappear={toggleVanishMode}
        recoverChat={recoverChat} setShowClearDialog={setShowClearDialog}
        anniversaryDate={appSettings.anniversaryDate}
      />

      {/* Pinned message banner */}
      <AnimatePresence>
        {pinnedMsg && (
          <PinnedMessageBanner msg={pinnedMsg} onJump={() => document.getElementById(`msg-${pinnedMsg.id}`)?.scrollIntoView({ behavior:"smooth", block:"center" })} />
        )}
      </AnimatePresence>

      {/* Vanish Mode banner — no duration text anymore (there's no duration).
          Tapping it opens the same destructive confirm as the header menu
          item / composer gesture, so there's exactly one way this ever
          actually deletes anything. */}
      <AnimatePresence>
        {disappearMode && (
          <motion.div initial={{ height:0,opacity:0 }} animate={{ height:"auto",opacity:1 }} exit={{ height:0,opacity:0 }} className="overflow-hidden">
            <div className="px-4 py-1.5 bg-primary/10 flex items-center justify-center gap-1.5">
              <Ghost className="h-3 w-3 text-primary animate-pulse-soft" />
              <span className="text-[10px] text-primary font-medium">
                Vanish Mode is on — messages stay until you turn it off
              </span>
              <button onClick={() => { setShowEndVanishConfirm(true); }} className="ml-1 text-[10px] text-primary underline">turn off</button>
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
        bottomInset={bottomInset}
        surpriseStageById={surpriseStageById} onOpenSurprise={openSurprise}
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
      {/* Attach tray now renders INSIDE MessageComposer (redesign §3 —
          expands as part of the same glass surface) — see attachActions
          passed to MessageComposer below. */}
      {composerHostEl
        ? createPortal(
            <MessageComposer
              replyTo={replyTo} setReplyTo={setReplyTo} partnerName={partnerName} userId={user?.id}
              editingMsg={editingMsg} setEditingMsg={setEditingMsg} setEditText={setEditText} setMessage={setMessage}
              disappearMode={disappearMode} onToggleDisappear={toggleVanishMode}
              isRecording={isRecording} recordingTime={recordingTime} formatRecTime={formatRecTime}
              cancelRecording={cancelRecording} stopRecording={stopRecording} startRecording={startRecording}
              showAttach={showAttach} setShowAttach={setShowAttach} inputRef={inputRef} message={message}
              broadcastTyping={broadcastTyping} editText={editText} handleSend={handleSend}
              showGridMenu={showGridMenu} setShowGridMenu={setShowGridMenu} setShowSchedulePicker={setShowSchedulePicker}
              attachActions={attachActions}
            />,
            composerHostEl,
          )
        : (
          <MessageComposer
            replyTo={replyTo} setReplyTo={setReplyTo} partnerName={partnerName} userId={user?.id}
            editingMsg={editingMsg} setEditingMsg={setEditingMsg} setEditText={setEditText} setMessage={setMessage}
            disappearMode={disappearMode} onToggleDisappear={toggleVanishMode}
            isRecording={isRecording} recordingTime={recordingTime} formatRecTime={formatRecTime}
            cancelRecording={cancelRecording} stopRecording={stopRecording} startRecording={startRecording}
            showAttach={showAttach} setShowAttach={setShowAttach} inputRef={inputRef} message={message}
            broadcastTyping={broadcastTyping} editText={editText} handleSend={handleSend}
            showGridMenu={showGridMenu} setShowGridMenu={setShowGridMenu} setShowSchedulePicker={setShowSchedulePicker}
            attachActions={attachActions}
          />
        )}

      {/* Hidden inputs */}
      <input ref={imageInputRef} type="file" accept="image/*,video/*" className="hidden" onChange={e=>handleFileSelect(e,"image")} />
      <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={e=>handleFileSelect(e,"image")} />
      <input ref={fileInputRef} type="file" className="hidden" onChange={e=>handleFileSelect(e,"file")} />
      {permissionSheet}

      {/* Vanish Mode redesign: there's no duration to pick anymore, so the
          old bottom sheet is gone. Turning it off is destructive and
          permanent (hard delete, no record, both sides), so it gets one
          explicit confirm — same AlertDialog pattern as "Clear chat?"
          below — regardless of whether it was triggered from the header
          menu, the banner's "turn off" link, or the composer's pull
          gesture (see DisappearGestureHandle / toggleVanishMode). */}
      <AlertDialog open={showEndVanishConfirm} onOpenChange={setShowEndVanishConfirm}>
        <AlertDialogContent className="rounded-2xl max-w-[320px]">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm font-semibold flex items-center gap-1.5"><Ghost className="h-4 w-4" /> Turn off Vanish Mode?</AlertDialogTitle>
            <AlertDialogDescription className="text-xs">Every message sent while it was on will be permanently deleted for both of you — no record, can't be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-full text-xs h-8">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { hapticError(); endVanishMode(); }} className="rounded-full bg-destructive text-destructive-foreground text-xs h-8">Turn Off &amp; Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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

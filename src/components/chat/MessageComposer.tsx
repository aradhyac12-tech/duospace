import { motion, AnimatePresence } from "framer-motion";
import { Pencil, X, Paperclip, BellOff, Send, Check, Mic, Trash2 } from "lucide-react";
import type { RefObject, Dispatch, SetStateAction } from "react";
import ReplyPreview from "@/components/chat/ReplyPreview";
import DisappearGestureHandle from "@/components/chat/DisappearGestureHandle";
import { HubButton } from "@/components/chat/GridMenu";
import { OnboardingTooltip } from "@/components/OnboardingTooltip";
import { hapticLight, hapticWarning, hapticSend, hapticMedium } from "@/lib/haptics";
import { DISAPPEAR_OPTIONS } from "@/lib/chatConstants";
import type { DecryptedMessage } from "@/types/chat";
import { useSetImmersive } from "@/hooks/useImmersiveMode";
import { useKeyboardOpen } from "@/hooks/useKeyboardOpen";
import { useState } from "react";

// ─── MessageComposer ─────────────────────────────────────────────────────────
// Pure presentational component covering the reply-state banner, edit-state
// banner, the disappearing-messages gesture handle, the recording-state UI,
// and the composer itself (attach / text input / send / hold-to-record mic /
// feature hub). Owns no send/recording/typing logic — all state and mutators
// live in Chat.tsx and are passed down. Extracted unchanged from
// pages/Chat.tsx (Phase 3 UI/state decomposition, continuation pass). Every
// pointer-capture / dedup / bug-fix comment from the original is preserved
// verbatim since those describe real, easy-to-regress platform behavior.

interface MessageComposerProps {
  replyTo: DecryptedMessage | null;
  setReplyTo: Dispatch<SetStateAction<DecryptedMessage | null>>;
  partnerName: string;
  userId: string | undefined;
  editingMsg: DecryptedMessage | null;
  setEditingMsg: Dispatch<SetStateAction<DecryptedMessage | null>>;
  setEditText: Dispatch<SetStateAction<string>>;
  setMessage: Dispatch<SetStateAction<string>>;
  disappearMode: boolean;
  disappearMs: number;
  setShowDisappearSheet: Dispatch<SetStateAction<boolean>>;
  setDisappearMode: Dispatch<SetStateAction<boolean>>;
  setDisappearMs: Dispatch<SetStateAction<number>>;
  isRecording: boolean;
  recordingTime: number;
  formatRecTime: (s: number) => string;
  cancelRecording: () => void;
  stopRecording: () => void;
  startRecording: () => void;
  showAttach: boolean;
  setShowAttach: Dispatch<SetStateAction<boolean>>;
  inputRef: RefObject<HTMLInputElement>;
  message: string;
  broadcastTyping: () => void;
  editText: string;
  handleSend: () => void;
  showGridMenu: boolean;
  setShowGridMenu: Dispatch<SetStateAction<boolean>>;
  setShowSchedulePicker: Dispatch<SetStateAction<boolean>>;
}

const MessageComposer = ({
  replyTo, setReplyTo, partnerName, userId,
  editingMsg, setEditingMsg, setEditText, setMessage,
  disappearMode, disappearMs, setShowDisappearSheet, setDisappearMode, setDisappearMs,
  isRecording, recordingTime, formatRecTime, cancelRecording, stopRecording, startRecording,
  showAttach, setShowAttach, inputRef, message, broadcastTyping, editText, handleSend,
  showGridMenu, setShowGridMenu, setShowSchedulePicker,
}: MessageComposerProps) => {
  // Typing-hide (per direct request, iOS/Instagram-style): the dock steps
  // fully aside while the message field is focused/keyboard is up, same
  // mechanism the photo/video viewer and camera already use to hide it —
  // see useImmersiveMode.ts. Registered only while actually focused, so a
  // blur (send, dismiss keyboard, tap elsewhere) immediately releases it;
  // useSetImmersive's own unmount cleanup covers navigating away mid-focus.
  const [isInputFocused, setIsInputFocused] = useState(false);
  useSetImmersive("chat-composer-typing", isInputFocused);
  // Keyboard audit: env(safe-area-inset-bottom) (the "safe-bottom" class
  // below) can keep padding for the home indicator even once the keyboard
  // is already covering that area — see useKeyboardOpen's doc comment.
  // Dropping just that padding while the keyboard's open removes the dead
  // gap without touching the composer's other spacing/layout.
  const keyboardOpen = useKeyboardOpen();

  return (
  <>
    {/* Reply preview */}
    <AnimatePresence>
      {replyTo && (
        <ReplyPreview replyToContent={replyTo.decryptedContent||"Message"}
          replyToSenderName={replyTo.sender_id===userId?"You":partnerName} onCancel={() => setReplyTo(null)} />
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
    {/* Phase 2 (visual correction): "the composer should feel like a
        floating physical object integrated into the bottom of the
        conversation." Was a flat bg-background/90 strip with a hard
        border-t across the full width — replaced with a bottom gradient
        scrim (matches ChatHeader's edge-integration treatment, no hard
        line) with the actual input pill/mic/hub button floating as
        distinct glass objects on top of it, rather than the whole row
        reading as one toolbar plane. */}
    <div className={`relative z-40 px-3 pb-3 pt-4 shrink-0 ${keyboardOpen ? "" : "safe-bottom"}`}>
      <div aria-hidden="true" className="absolute inset-x-0 bottom-0 top-0 -z-10 bg-gradient-to-t from-background via-background/85 to-transparent" />
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
          {/* DA-09: h-8 (32px) → h-11 (44px). These sit in an already-roomy
              row (waveform + timer + these two), so growing them doesn't
              compress anything else. */}
          <button onClick={() => { hapticWarning(); cancelRecording(); }} aria-label="Cancel voice recording" className="h-11 w-11 rounded-full bg-muted flex items-center justify-center"><Trash2 className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" /></button>
          <button onClick={() => { hapticSend(); stopRecording(); }} aria-label="Send voice recording" className="h-11 w-11 rounded-full bg-primary flex items-center justify-center"><Send className="h-3.5 w-3.5 text-primary-foreground" aria-hidden="true" /></button>
        </motion.div>
      ) : (
        <div className="flex items-center gap-1.5">
          <div className="flex-1 flex items-center gap-1 glass-sheet rounded-full px-2 py-1">
            {/* DA-09: this one sits inside the flex-1 input pill alongside
                the text field, so its box is constrained by the pill's own
                compact height (px-2 py-1) — pushing it to the full 44px
                baseline here would make it taller than the pill itself and
                distort the whole composer row. Bumped 32px → 36px, the
                largest step that still fits the pill cleanly; the pill's
                padding around it still gives real margin for a slightly
                imprecise tap even at 36px. */}
            <button onClick={() => { hapticLight(); setShowAttach(!showAttach); }}
              aria-label="Attachments"
              aria-expanded={showAttach}
              className="h-9 w-9 rounded-full flex items-center justify-center shrink-0 text-muted-foreground hover:text-foreground transition-colors">
              <Paperclip className="h-4 w-4" aria-hidden="true" />
            </button>
            <input ref={inputRef} type="text" value={message}
              aria-label="Message"
              onChange={e => { setMessage(e.target.value); broadcastTyping(); if(editingMsg) setEditText(e.target.value); }}
              onKeyDown={e => e.key==="Enter" && handleSend()}
              onFocus={() => setIsInputFocused(true)}
              onBlur={() => setIsInputFocused(false)}
              placeholder={editingMsg?"Edit message...":replyTo?"Reply...":"Message · /silent for no notification"}
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60 py-1.5" />
            {/^\/silent(\s|$)/i.test(message) && (
              <span className="text-[10px] text-muted-foreground/70 shrink-0 pr-1 flex items-center gap-0.5">
                <BellOff className="h-3 w-3" aria-hidden="true" /> silent
              </span>
            )}
          </div>
          {message.trim() ? (
            <motion.button initial={{ scale:0 }} animate={{ scale:1 }} whileTap={{ scale: 0.9 }} onClick={() => { handleSend(); }}
              aria-label={editingMsg ? "Save edit" : "Send message"}
              className="h-11 w-11 rounded-full bg-primary flex items-center justify-center shrink-0">
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
              className="h-11 w-11 rounded-full bg-primary flex items-center justify-center shrink-0 active:scale-95 transition-transform">
              <Mic className="h-4 w-4 text-primary-foreground" aria-hidden="true" />
            </button>
          )}
          {/* First-use discovery nudge for the hub — OnboardingTooltip
              already existed as a generic, dismiss-once, localStorage-
              persisted component (src/components/OnboardingTooltip.tsx)
              but wasn't wired anywhere in the app yet. side="left" so it
              grows away from the screen's right edge (the hub button sits
              close to it) instead of overflowing off-screen.
              dismissWhen={showGridMenu}: once the user opens the hub even
              once, they've found it — no need to keep it around after
              that, and it won't reappear on a later visit either (see the
              component's own dismissWhen doc).
              Text is a plain string, matching this file's and the rest of
              the chat surface's existing convention — the app's i18n
              module (src/lib/i18n.ts) is scoped to the splash screen only
              (confirmed: no other component imports it), so adding it here
              would be a second, inconsistent localization path rather than
              following an existing one. */}
          <div className="relative">
            <HubButton onClick={() => { hapticMedium(); setShowGridMenu(!showGridMenu); }} isOpen={showGridMenu}
              onLongPress={message.trim() ? () => { setShowGridMenu(false); setShowSchedulePicker(true); } : undefined} />
            <OnboardingTooltip id="chat-hub" text="Explore your shared space — gallery, music & more" emoji="✨" side="left" dismissWhen={showGridMenu} />
          </div>
        </div>
      )}
    </div>
  </>
  );
};

export default MessageComposer;

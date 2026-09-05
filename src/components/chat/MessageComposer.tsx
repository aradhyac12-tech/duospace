import { motion, AnimatePresence } from "framer-motion";
import { Pencil, X, Paperclip, BellOff, Send, Check, Mic, Trash2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { RefObject, Dispatch, SetStateAction } from "react";
import ReplyPreview from "@/components/chat/ReplyPreview";
import DisappearGestureHandle from "@/components/chat/DisappearGestureHandle";
import { HubButton } from "@/components/chat/GridMenu";
import { OnboardingTooltip } from "@/components/OnboardingTooltip";
import { hapticWarning, hapticSend, hapticMedium } from "@/lib/haptics";
import { microTransition, quickSpring } from "@/lib/motion";
import type { DecryptedMessage } from "@/types/chat";

import { useEffect, useState } from "react";
// PHASE 5.5 (Unified Bottom Surface, this pass): MessageComposer no longer
// owns any dock-clearance/safe-area positioning math at all — it used to
// (see git history for the old ROOT-CAUSE FIX trace fixing the dock sitting
// on top of the Send button), because it rendered in Chat's own document
// flow directly above a separately-floating FloatingDock. Both of those
// premises are gone: this component's whole return value now gets portaled
// (see Chat.tsx's useComposerHost) into DuoSpaceBottomSurface, a single
// fixed-position glass shell that ALSO contains the Chat/Calls nav row —
// one continuous material, not two stacked pills. Positioning, safe-area
// inset, and keyboard-follow are all owned by that shell now. This file
// goes back to being purely about composer CONTENT (reply/edit banners,
// attach tray, recording UI, the input row itself).
//
// ─── MessageComposer ─────────────────────────────────────────────────────────
// Pure presentational component covering the reply-state banner, edit-state
// banner, the disappearing-messages gesture handle, the attach tray, the
// recording-state UI, and the composer itself. Owns no send/recording/
// typing/upload logic — all state and mutators live in Chat.tsx and are
// passed down.
//
// Design System 2.0 — Phase 5.5 composer rewrite. The whole row is one
// .glass-sheet-family surface (Hub | growing textarea | Attach/Send/Mic),
// and the field is a <textarea> that grows up to a capped max-height, then
// scrolls internally. inputRef's element type is HTMLTextAreaElement.

const COMPOSER_MIN_H = 40; // px — single-line resting height of the textarea itself
const COMPOSER_MAX_H = 128; // px — cap before internal scroll kicks in (state C)

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
  onToggleDisappear: () => void;
  isRecording: boolean;
  recordingTime: number;
  formatRecTime: (s: number) => string;
  cancelRecording: () => void;
  stopRecording: () => void;
  startRecording: () => void;
  showAttach: boolean;
  setShowAttach: Dispatch<SetStateAction<boolean>>;
  inputRef: RefObject<HTMLTextAreaElement>;
  message: string;
  broadcastTyping: () => void;
  editText: string;
  handleSend: () => void;
  showGridMenu: boolean;
  setShowGridMenu: Dispatch<SetStateAction<boolean>>;
  setShowSchedulePicker: Dispatch<SetStateAction<boolean>>;
  /** Attach-tray items (Photo/Camera/File/Schedule). Rendered INSIDE this
   *  same surface now (redesign brief §3: "the attachment panel expands
   *  INSIDE/AS PART OF the same glass surface rather than appearing as an
   *  unrelated floating component") — Chat.tsx still owns the actual
   *  ensureMedia()/file-input-ref click handlers, this just renders them. */
  attachActions: { label: string; icon: LucideIcon; onClick: () => void }[];
}

const MessageComposer = ({
  replyTo, setReplyTo, partnerName, userId,
  editingMsg, setEditingMsg, setEditText, setMessage,
  disappearMode, onToggleDisappear,
  isRecording, recordingTime, formatRecTime, cancelRecording, stopRecording, startRecording,
  showAttach, setShowAttach, inputRef, message, broadcastTyping, editText, handleSend,
  showGridMenu, setShowGridMenu, setShowSchedulePicker, attachActions,
}: MessageComposerProps) => {
  const [isInputFocused, setIsInputFocused] = useState(false);

  // Auto-grow textarea (State C — multiline). Reset to "auto" first so a
  // deletion can shrink the box back down (scrollHeight only ever grows
  // once a height is set), then read the real content height and clamp it
  // to COMPOSER_MAX_H. Past that cap the textarea's own overflow-y:auto
  // (in the className below) takes over rather than the composer growing
  // indefinitely down the screen.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_H)}px`;
  }, [message, inputRef]);

  const isSilentDraft = /^\/silent(\s|$)/i.test(message);

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
          <button onClick={() => { setEditingMsg(null); setEditText(""); setMessage(""); }} aria-label="Cancel edit">
            <X className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          </button>
        </motion.div>
      )}
    </AnimatePresence>

    {/* Input area */}
    {/* BUG FIX (kept from prior pass): this had no z-index, so
        DisappearGestureHandle's full-viewport dim overlay (fixed inset-0
        z-30, up to ~55-60% black) rendered visually on top of it whenever
        Vanish Mode is on or mid-drag — the whole compose bar looked
        covered by a black box. The dim is meant to darken the chat above,
        not the input controls themselves. */}
    {/* Positioning note (redesign §1/§10): this row no longer owns any
        safe-area/dock-clearance/keyboard math — DuoSpaceBottomSurface (the
        fixed shell this whole component is portaled into) owns all of
        that, once, for the composer AND the nav row together. This is now
        purely the composer's own internal padding. */}
    <div className="relative z-10 px-3 pt-2.5 pb-2 shrink-0">
      <div className="flex justify-center">
        <DisappearGestureHandle
          active={disappearMode}
          onToggle={onToggleDisappear}
        />
      </div>

      {/* Attach tray (redesign §3): expands INSIDE this same surface now,
          rather than as Chat.tsx's own separately-floating glass card above
          the composer. transform-origin bottom-center so the scale-in
          reads as this surface's own material extending upward. */}
      <AnimatePresence>
        {showAttach && !isRecording && (
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.94, height: 0 }}
            animate={{ opacity: 1, y: 0, scale: 1, height: "auto" }}
            exit={{ opacity: 0, y: 6, scale: 0.96, height: 0 }}
            transition={{ type: "spring", stiffness: 500, damping: 32 }}
            style={{ transformOrigin: "bottom center", overflow: "hidden" }}
            className="flex gap-2 pb-2"
          >
            {attachActions.map(({ label, icon: Icon, onClick }) => (
              <button key={label} onClick={() => { setShowAttach(false); onClick(); }} className="flex flex-col items-center gap-1.5 flex-1 active:scale-95 transition-transform group">
                <span className="h-11 w-11 rounded-full flex items-center justify-center bg-muted group-hover:bg-accent/15 transition-colors">
                  <Icon className="h-5 w-5 text-foreground/70 group-hover:text-accent transition-colors" />
                </span>
                <span className="text-[11px] text-muted-foreground">{label}</span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

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
          <button onClick={() => { hapticWarning(); cancelRecording(); }} aria-label="Cancel voice recording" className="h-11 w-11 rounded-full bg-muted flex items-center justify-center"><Trash2 className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" /></button>
          <button onClick={() => { hapticSend(); stopRecording(); }} aria-label="Send voice recording" className="h-11 w-11 rounded-full bg-primary flex items-center justify-center"><Send className="h-3.5 w-3.5 text-primary-foreground" aria-hidden="true" /></button>
        </motion.div>
      ) : (
        // One composite surface — Files, text field, Record/Send, and Hub all
        // live inside this single .glass-sheet pill (redesign §9-11 + the
        // Phase: Global Glass brief §4/§12, which fixes the FINAL order:
        // [FILES] MESSAGE [RECORD/SEND] [HUB] — Files leftmost, Hub far
        // right, and the record control swapping to Send while text exists;
        // never a separate floating button outside the composer). items-end
        // keeps the controls pinned to the pill's bottom edge as the textarea
        // grows upward (State C), so a multiline draft doesn't leave
        // Hub/Send floating awkwardly at a half-height. rounded-[26px]
        // rather than rounded-full: at resting single-line height it still
        // reads as a full pill, but it doesn't warp into a stadium shape
        // once the field grows tall.
        <motion.div
          layout
          transition={quickSpring}
          className="glass-sheet rounded-floating flex items-end gap-1 pl-1.5 pr-1.5 py-1.5"
        >
          <div className="pb-0.5 flex items-center gap-1">
            {/* FILES — leftmost per brief §4/§12. Attach stays a quiet
                icon-only control inside the same surface rather than a
                separate floating button. */}
            <button onClick={() => { setShowAttach(!showAttach); }}
              aria-label="Attachments"
              aria-expanded={showAttach}
              className="h-9 w-9 rounded-full flex items-center justify-center shrink-0 text-muted-foreground hover:text-foreground transition-colors">
              <Paperclip className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          <div className="relative flex-1 min-w-0">
            <textarea
              ref={inputRef}
              rows={1}
              value={message}
              aria-label="Message"
              onChange={e => { setMessage(e.target.value); broadcastTyping(); if(editingMsg) setEditText(e.target.value); }}
              onKeyDown={e => {
                // Enter sends (matches the prior single-line behavior);
                // Shift+Enter inserts a real newline for a multiline draft.
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              onFocus={() => setIsInputFocused(true)}
              onBlur={() => setIsInputFocused(false)}
              placeholder={editingMsg?"Edit message...":replyTo?"Reply...":"Message..."}
              style={{ minHeight: COMPOSER_MIN_H, maxHeight: COMPOSER_MAX_H }}
              // FIX (Vanish Mode text not visible): no color class here
              // meant the typed text just inherited whatever color an
              // ancestor above Chat's `.vanish-mode` div had already
              // resolved for `color` under the regular theme — inheritance
              // carries the computed value, not the variable reference, so
              // it never picked up Vanish Mode's near-white foreground even
              // though the glass pill behind it correctly went dark.
              // Explicit `text-foreground` re-resolves right here.
              className="w-full bg-transparent text-sm text-foreground outline-none focus-visible:ring-0 focus-visible:outline-none resize-none placeholder:text-muted-foreground/60 py-2 leading-snug overflow-y-auto"
            />
            {isSilentDraft && (
              <span className="absolute -top-1 right-0 text-[10px] text-muted-foreground/70 shrink-0 flex items-center gap-0.5 bg-background/80 rounded-full px-1.5 py-0.5 backdrop-blur-sm">
                <BellOff className="h-3 w-3" aria-hidden="true" /> silent
              </span>
            )}
          </div>

          {/* RECORD/SEND — right of the field, before the Hub (brief
              §4/§12). Send replaces Record exactly while text exists. */}
          <div className="pb-0.5 flex items-center gap-1">
            <AnimatePresence mode="wait" initial={false}>
              {message.trim() ? (
                <motion.button key="send" initial={{ scale:0 }} animate={{ scale:1 }} exit={{ scale:0 }}
                  transition={microTransition} whileTap={{ scale: 0.9 }} onClick={handleSend}
                  aria-label={editingMsg ? "Save edit" : "Send message"}
                  className="h-11 w-11 rounded-full bg-primary flex items-center justify-center shrink-0">
                  {editingMsg ? <Check className="h-4 w-4 text-primary-foreground" aria-hidden="true" /> : <Send className="h-4 w-4 text-primary-foreground" aria-hidden="true" />}
                </motion.button>
              ) : (
                <motion.button key="mic" initial={{ scale:0 }} animate={{ scale:1 }} exit={{ scale:0 }}
                  transition={microTransition}
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
                </motion.button>
              )}
            </AnimatePresence>
          </div>

          {/* HUB — far right, always last per brief §4/§12. Opens its menu
              anchored directly above this button (GridMenu measures
              #chat-hub-button's live rect; right-3 on the panel now lines up
              exactly with this button's right edge). */}
          <div className="relative pb-0.5">
            <HubButton onClick={() => { hapticMedium(); setShowGridMenu(!showGridMenu); }} isOpen={showGridMenu}
              onLongPress={message.trim() ? () => { setShowGridMenu(false); setShowSchedulePicker(true); } : undefined} />
            <OnboardingTooltip id="chat-hub" text="Explore your shared space — gallery, music & more" emoji="✨" side="left" dismissWhen={showGridMenu} />
          </div>
        </motion.div>
      )}
    </div>
  </>
  );
};

export default MessageComposer;

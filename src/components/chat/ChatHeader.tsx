import { motion, AnimatePresence } from "framer-motion";
import {
  ChevronRight, ChevronUp, ChevronDown, Search, X, Video, Phone,
  MoreVertical, Heart, Timer, TimerOff, Reply, Trash2,
} from "lucide-react";
import type { RefObject, Dispatch, SetStateAction } from "react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuTrigger, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { hapticLight, hapticMedium, hapticTick, hapticWarning } from "@/lib/haptics";
import { routePreload } from "@/App";
import { DISAPPEAR_OPTIONS } from "@/lib/chatConstants";

// ─── ChatHeader ──────────────────────────────────────────────────────────────
// Pure presentational component — identity row, call-initiate buttons,
// overflow menu, and the collapsible search bar ("Chat header" +
// "Conversation status" layers). Owns no chat/call/search state itself;
// everything is passed in as props/callbacks. Extracted unchanged from
// pages/Chat.tsx (Phase 3 UI/state decomposition, continuation pass).

interface ChatHeaderProps {
  partnerAvatar: string | null;
  appIcon: string | null;
  appName: string;
  partnerId: string | null;
  partnerName: string;
  disappearMode: boolean;
  disappearMs: number;
  partnerTyping: boolean;
  partnerOnline: boolean;
  e2eReady: boolean;
  isStartingCall: boolean;
  startCall: (mode: "video" | "voice") => void;
  navigate: (path: string) => void;
  sendNudge: () => void;
  setSearchOpen: Dispatch<SetStateAction<boolean>>;
  searchOpen: boolean;
  setSearchQuery: Dispatch<SetStateAction<string>>;
  searchQuery: string;
  searchInputRef: RefObject<HTMLInputElement>;
  searchResults: string[];
  searchIndex: number;
  setSearchIndex: Dispatch<SetStateAction<number>>;
  setDisappearMode: Dispatch<SetStateAction<boolean>>;
  setShowDisappearSheet: Dispatch<SetStateAction<boolean>>;
  recoverChat: () => void;
  setShowClearDialog: (v: boolean) => void;
  /** DA-06: relationship-context surface — see the badge below. Purely
   * derived display data (same date math Us.tsx already uses for its own
   * anniversary card), not new state; null/undefined when unset, which is
   * the common case and renders nothing extra. */
  anniversaryDate?: string | null;
}

const ChatHeader = ({
  partnerAvatar, appIcon, appName, partnerId, partnerName,
  disappearMode, disappearMs, partnerTyping, partnerOnline, e2eReady,
  isStartingCall, startCall, navigate, sendNudge,
  setSearchOpen, searchOpen, setSearchQuery, searchQuery, searchInputRef,
  searchResults, searchIndex, setSearchIndex,
  setDisappearMode, setShowDisappearSheet, recoverChat, setShowClearDialog,
  anniversaryDate,
}: ChatHeaderProps) => {
  // DA-06: same "years together" math Us.tsx's anniversary card already
  // uses — reusing it here rather than introducing a second definition of
  // "how long have they been together." Deliberately NOT the day-count
  // streak also shown on Us.tsx: that one requires a real message-history
  // query, and duplicating it here on every chat-header render would be
  // exactly the "unnecessary API call" this pass was told to avoid. This
  // is a free, purely-derived number instead.
  let yearsTogether: number | null = null;
  if (anniversaryDate) {
    const ann = new Date(anniversaryDate);
    const today = new Date();
    const nextAnn = new Date(ann);
    nextAnn.setFullYear(today.getFullYear());
    if (nextAnn < today) nextAnn.setFullYear(today.getFullYear() + 1);
    yearsTogether = today.getFullYear() - ann.getFullYear() + (nextAnn.getFullYear() > today.getFullYear() ? 0 : 1);
  }

  return (
  // Phase 2 (visual correction): the header was a conventional bordered
  // toolbar (solid bg-background/90, hard border-b) — replaced with an
  // edge-integrated identity element that fades into the conversation
  // instead of sitting in a boxed bar. The gradient scrim (fading to
  // transparent) does the job border-b used to do — separating header from
  // content — without a hard line, so messages can visually scroll up
  // underneath it. No blur on the scrim itself (a blurred gradient over
  // moving content looks smeary); the identity row's own elements carry
  // their own depth instead.
  <header className="safe-top relative px-3 pt-3 pb-4 sticky top-0 z-20 pointer-events-none">
    <div aria-hidden="true" className="absolute inset-0 -z-10 bg-gradient-to-b from-background via-background/85 to-transparent" />
    <div className="flex items-center justify-between gap-1 pointer-events-auto">
      <motion.button
        whileTap={{ scale: 0.97 }}
        onClick={() => { hapticLight(); navigate("/profile"); }}
        onPointerDown={() => routePreload["/profile"]?.().catch(() => {})}
        className="flex items-center gap-2.5 min-w-0 -ml-1 pl-1 pr-2 py-1 rounded-full active:bg-muted/30 transition-colors"
        aria-label="Open profile"
      >
        {/* Avatar depth: a soft ring + lifted shadow instead of a flat
            circle, so identity reads as the header's one dimensional
            element rather than everything sitting at the same flat plane. */}
        <div className="relative h-10 w-10 rounded-full bg-muted flex items-center justify-center overflow-hidden shrink-0 ring-1 ring-border/40 shadow-[0_4px_14px_-4px_hsl(var(--foreground)/0.22)]">
          {partnerAvatar ? (
            <img src={partnerAvatar} alt="" className="h-full w-full object-cover" />
          ) : appIcon ? (
            <img src={appIcon} alt={appName} className="h-full w-full object-cover" />
          ) : (
            <span className="text-[10px] font-semibold text-muted-foreground">{appName.slice(0,2).toUpperCase()}</span>
          )}
          {partnerOnline && (
            <span aria-hidden="true" className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-success ring-2 ring-background" />
          )}
        </div>
        <div className="min-w-0 text-left">
          {/* Partner name is the main identity — bumped a step and given
              real weight; presence/status drops to a genuinely secondary
              line below (no green-dot emoji clutter inline with the name
              anymore, the dot now lives on the avatar itself above). */}
          <h1 className="text-[15px] font-semibold text-foreground leading-tight flex items-center gap-1.5 tracking-tight">
            <span className="truncate">{partnerId ? partnerName : appName}</span>
            {disappearMode && (
              <span title={`Disappearing messages: ${DISAPPEAR_OPTIONS.find(o=>o.value===disappearMs)?.label ?? ""}`}
                className="inline-flex items-center gap-0.5 bg-primary/15 text-primary text-[9px] font-semibold px-1.5 py-0.5 rounded-full shrink-0">
                <Timer className="h-2.5 w-2.5" /> ON
              </span>
            )}
            {/* DA-06: minimal relationship-context surface — only appears
                once an anniversary date is actually set in Settings, never
                a placeholder/invented value. Reuses the same small-badge
                treatment as the disappearing-messages indicator above so it
                reads as part of the same visual language, not a bolted-on
                widget. */}
            {yearsTogether !== null && (
              <span title="Years together — see Us for the full anniversary countdown"
                className="inline-flex items-center gap-0.5 bg-primary/10 text-primary/90 text-[9px] font-semibold px-1.5 py-0.5 rounded-full shrink-0">
                💍 Yr {yearsTogether}
              </span>
            )}
          </h1>
          <p className="text-[11px] text-muted-foreground/80 leading-tight truncate">
            {partnerTyping?"typing...":partnerOnline?"online":e2eReady?"end-to-end encrypted":partnerId?"securing…":"Link a partner in settings"}
          </p>
        </div>
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" aria-hidden="true" />
      </motion.button>
      <div className="flex items-center gap-0.5">
        {/* Call controls restrained per spec: no persistent filled/hover
            circle sitting behind the glyph at rest — the icon itself is
            the whole control, background only appears on active press, so
            these read as quiet secondary actions rather than competing
            with the identity row for visual weight. 44px tap target
            preserved (h-11 w-11), just no resting chrome inside it. */}
        <button onClick={() => { hapticMedium(); startCall("video"); }} disabled={isStartingCall||!partnerId}
          aria-label="Start video call"
          className="h-11 w-11 rounded-full flex items-center justify-center text-muted-foreground/70 active:bg-muted/50 active:text-foreground transition-colors disabled:opacity-30">
          <Video className="h-[17px] w-[17px]" aria-hidden="true" />
        </button>
        <button onClick={() => { hapticMedium(); startCall("voice"); }} disabled={isStartingCall||!partnerId}
          aria-label="Start voice call"
          className="h-11 w-11 rounded-full flex items-center justify-center text-muted-foreground/70 active:bg-muted/50 active:text-foreground transition-colors disabled:opacity-30">
          <Phone className="h-[16px] w-[16px]" aria-hidden="true" />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button aria-label="More chat options" className="h-11 w-11 rounded-full flex items-center justify-center text-muted-foreground/70 active:bg-muted/50 active:text-foreground transition-colors">
              <MoreVertical className="h-[17px] w-[17px]" aria-hidden="true" />
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
            <DropdownMenuItem onClick={() => { hapticLight(); if (disappearMode) setDisappearMode(false); else setShowDisappearSheet(true); }}>
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

    {/* Search bar — now the header's only actual "surface" (everything else
        floats on the gradient scrim), so it gets real glass treatment
        rather than a flat muted fill, consistent with the rest of the
        material system. */}
    <AnimatePresence>
      {searchOpen && (
        <motion.div initial={{ height:0,opacity:0 }} animate={{ height:"auto",opacity:1 }} exit={{ height:0,opacity:0 }} transition={{ duration:0.15 }} className="overflow-hidden pointer-events-auto">
          <div className="flex items-center gap-2 mt-2 glass-sheet rounded-full px-3 py-1.5">
            <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <input ref={searchInputRef} type="text" value={searchQuery} onChange={e=>setSearchQuery(e.target.value)}
              placeholder="Search loaded messages..." className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
            {searchResults.length>0 && (
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-muted-foreground whitespace-nowrap">{searchIndex+1}/{searchResults.length}</span>
                {/* DA-09: bumped h-6 (24px) to h-8 (32px) — this compact
                    search row can't take the full 44px baseline without
                    breaking its own fit, but 24px was well under any
                    reasonable minimum; 32px is the largest that still sits
                    comfortably in this pill without changing its height. */}
                <button onClick={() => { hapticTick(); setSearchIndex(i=>Math.max(0,i-1)); }} aria-label="Previous match" className="h-8 w-8 flex items-center justify-center text-muted-foreground"><ChevronUp className="h-3.5 w-3.5" aria-hidden="true" /></button>
                <button onClick={() => { hapticTick(); setSearchIndex(i=>Math.min(searchResults.length-1,i+1)); }} aria-label="Next match" className="h-8 w-8 flex items-center justify-center text-muted-foreground"><ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /></button>
              </div>
            )}
            <button onClick={() => { hapticLight(); setSearchOpen(false); setSearchQuery(""); }} aria-label="Close search" className="h-8 w-8 flex items-center justify-center text-muted-foreground"><X className="h-3.5 w-3.5" aria-hidden="true" /></button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  </header>
  );
};

export default ChatHeader;

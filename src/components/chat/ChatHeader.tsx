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
          <p className="text-[11px] text-muted-foreground leading-tight truncate">
            {partnerTyping?"typing...":partnerOnline?"🟢 online":e2eReady?"end-to-end encrypted":partnerId?"securing…":"Link a partner in settings"}
          </p>
        </div>
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" aria-hidden="true" />
      </motion.button>
      <div className="flex items-center gap-1">
        {/* DA-09: these were h-9 w-9 (36px) — bumped to the 44px hit-area
            baseline. Icon glyph sizes are unchanged, so visually the row
            looks identical; only the tappable area grew. */}
        <button onClick={() => { hapticMedium(); startCall("video"); }} disabled={isStartingCall||!partnerId}
          aria-label="Start video call"
          className="h-11 w-11 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-30">
          <Video className="h-[18px] w-[18px]" aria-hidden="true" />
        </button>
        <button onClick={() => { hapticMedium(); startCall("voice"); }} disabled={isStartingCall||!partnerId}
          aria-label="Start voice call"
          className="h-11 w-11 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-30">
          <Phone className="h-[17px] w-[17px]" aria-hidden="true" />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button aria-label="More chat options" className="h-11 w-11 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors">
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

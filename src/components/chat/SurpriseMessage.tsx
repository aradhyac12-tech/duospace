import { motion, useReducedMotion } from "framer-motion";
import { Check, CheckCheck, Gift } from "lucide-react";
import type { EngineSurprise } from "@/lib/surpriseEngine";
import type { SurpriseStage } from "@/lib/surpriseLifecycle";
import { stageLabel } from "@/lib/surpriseLifecycle";

// ─── SurpriseMessage ─────────────────────────────────────────────────────
// Surprise 2.0, phase 1 (redesign brief §1-4): a surprise's default state
// is a real row in the chat timeline, not an overlay/popup. This is that
// row — MessageTimeline renders one per `{ type: "surprise" }` TimelineItem,
// positioned chronologically among real messages exactly like CallEvent
// already does for calls.
//
// Phase 3 (§12/13): the entrance animation below (initial→animate) is this
// row's visual MATERIALIZE moment — but the haptic for it is fired by
// useChatSurprise, one level up, NOT here. Reasoning: on a cold chat-open,
// potentially many historical never-opened surprises mount as rows all at
// once, and this component has no way to tell "I'm one of a fresh live
// arrival" apart from "I'm backlog that just happens to render for the
// first time this session" — the hook DOES know that distinction (it's
// the same one it already uses to gate the receive haptic), so both
// receive() and materialize() fire together from there for a genuine new
// arrival, and neither fires for backlog. This component stays purely
// visual.
//
// What this intentionally does NOT do yet (later phase per the brief):
// no WebGL scene, no device-tilt depth. Tapping it opens the existing
// SurpriseReveal overlay as-is — the "expanded" experience described in
// §15 already exists; this component's job is the embedded default state.

interface SurpriseMessageProps {
  surprise: EngineSurprise;
  isMine: boolean;
  stage: SurpriseStage;
  partnerName: string;
  partnerAvatar: string | null;
  createdAt: string;
  formatTime: (iso: string) => string;
  onOpen: () => void;
}

const SurpriseMessage = ({
  surprise, isMine, stage, partnerName, partnerAvatar, createdAt, formatTime, onOpen,
}: SurpriseMessageProps) => {
  const prefersReducedMotion = useReducedMotion();
  const isFresh = !isMine && (stage === "delivered" || stage === "received"); // not yet seen — worth a little more visual pull
  const opened = stage === "opened" || stage === "interacting" || stage === "completed";

  // §2: partner connection — a tiny avatar + connecting glow so an inbound
  // surprise visibly originates from them, without a separate "your partner
  // sent a surprise" text line spelling it out.
  const originAvatar = !isMine && (
    <div className="relative h-6 w-6 shrink-0 rounded-full overflow-hidden bg-muted mt-auto mb-0.5" aria-hidden="true">
      {partnerAvatar ? (
        <img src={partnerAvatar} alt="" className="h-full w-full object-cover" />
      ) : (
        <div className="h-full w-full flex items-center justify-center text-[10px] font-semibold text-muted-foreground">
          {partnerName?.[0]?.toUpperCase() ?? "?"}
        </div>
      )}
    </div>
  );

  return (
    <div className={`flex ${isMine ? "justify-end" : "justify-start"} items-end gap-1.5 px-3 py-1`}>
      {originAvatar}
      <motion.button
        type="button"
        onClick={onOpen}
        aria-label={
          isMine
            ? `Surprise you sent, ${stageLabel(stage).toLowerCase()}`
            : `Surprise from ${partnerName || "your partner"} — tap to open`
        }
        initial={prefersReducedMotion ? false : { opacity: 0, y: 6, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.35, ease: "easeOut" }}
        whileTap={prefersReducedMotion ? undefined : { scale: 0.98 }}
        className={`
          relative max-w-[75%] rounded-2xl px-4 py-3 text-left
          border backdrop-blur-sm overflow-hidden
          ${isMine
            ? "bg-primary/10 border-primary/20 rounded-tr-sm"
            : "bg-gradient-to-br from-primary/15 via-fuchsia-500/10 to-transparent border-primary/25 rounded-tl-sm"}
        `}
      >
        {/* Soft glow — the 3D scene's stand-in until phase 2. Static under
            reduced motion instead of pulsing. */}
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute -inset-6 rounded-full bg-primary/20 blur-2xl ${
            isFresh && !prefersReducedMotion ? "animate-pulse" : ""
          }`}
        />
        <div className="relative flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/20 text-primary shrink-0">
            <Gift className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">
              {surprise.title || "A surprise"}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {isMine ? "Tap to preview" : opened ? "Tap to reopen" : "Tap to open"}
            </p>
          </div>
        </div>

        <div className="relative flex items-center gap-1 justify-end mt-1.5">
          {isMine && (
            <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
              {stageLabel(stage)}
              {stage === "opened" || stage === "interacting" || stage === "completed" ? (
                <CheckCheck className="h-3 w-3 text-info" />
              ) : stage === "seen" ? (
                <CheckCheck className="h-3 w-3 text-muted-foreground/60" />
              ) : (
                <Check className="h-3 w-3 text-muted-foreground/60" />
              )}
            </span>
          )}
          <span className="text-[10px] text-muted-foreground/70">{formatTime(createdAt)}</span>
        </div>
      </motion.button>
    </div>
  );
};

export default SurpriseMessage;

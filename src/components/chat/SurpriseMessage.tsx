import { useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Check, CheckCheck, Gift } from "lucide-react";
import { surpriseVariant, type EngineSurprise } from "@/lib/surpriseEngine";
import type { SurpriseStage } from "@/lib/surpriseLifecycle";
import { stageLabel } from "@/lib/surpriseLifecycle";

// ─── SurpriseMessage ─────────────────────────────────────────────────────
// Surprise 2.0, phase 1 (redesign brief §1-4): a surprise's default state
// is a real row in the chat timeline, not an overlay/popup. This is that
// row — MessageTimeline renders one per `{ type: "surprise" }` TimelineItem,
// positioned chronologically among real messages exactly like CallEvent
// already does for calls.
//
// Phase 2 (visual correction, embedded-lens pass): the earlier version of
// this row was its own bordered/backdrop-blurred pill with a big pulsing
// halo behind it — exactly the "float a card on top of the chat" pattern
// MessageBubble's partner tone was already corrected AWAY from (see the
// "don't put every message in a card / don't add shadows to every message"
// note over there). A surprise sitting in the same timeline shouldn't look
// like a different kind of object floating over the conversation — it
// should read as one MORE bubble in the stream, using the exact same
// shell (bg-primary / bg-[hsl(var(--surface-2))], rounded-2xl with the
// same tail corner) as every other message.
//
// The "3D / feels real" ask is answered INSIDE that shell instead of
// around it: a small lens — the same material idea as .glass-dock-lens in
// index.css, "a denser, more refractive pocket of the SAME material," not
// a different-colored chip dropped on top — is pressed into the bubble via
// inset shadows (a dark inset top-left, like the surface actually recedes,
// and a bright inset bottom-right catching light off the rim). That's a
// physical, always-on depth cue that costs nothing to render, as opposed
// to the full reveal's pointer/gyroscope-driven tilt (see
// useDeviceTilt.ts / SurpriseReveal.tsx) — this row is the "peek" tier,
// not the "takeover" tier, so it deliberately doesn't reuse that live
// tilt: a chat list scrolling past several of these should stay calm, and
// the continuous-tilt treatment stays reserved for the moment someone has
// actually committed to opening one.
//
// What this intentionally does NOT do (later phase per the brief): no
// WebGL scene, no device-tilt depth here. Tapping it still opens the
// existing SurpriseReveal overlay as-is — the "expanded" experience
// described in §15 already exists; this component's job is only the
// embedded default state.
//
// Phase 2b (individuality pass): every lens was rendering the exact same
// neutral tint regardless of which surprise it was, which reads as one
// stamped-out asset repeated down the timeline rather than a set of
// distinct real objects. surpriseVariant(surprise.id) is the same
// deterministic per-surprise hash SurpriseReveal already keys its own
// identity off of (richScene, particle seed) — reusing it here means the
// embedded lens and the eventual full-reveal card agree on which surprise
// is which without any new state, and it's identical for both people
// since it's derived from the id, not local randomness.

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
  const [isPressed, setIsPressed] = useState(false);

  // Per-surprise hue, not per-render random — see the phase-2b note above.
  // Kept as a narrow, muted band (200 wide, moderate saturation/lightness)
  // rather than the full wheel: this is a faint identity tint on a small
  // recessed lens sitting inside a bubble that still needs to read
  // clearly as "sent"/"received", not a colorful sticker competing with
  // that.
  const hue = surpriseVariant(surprise.id).seed % 200;

  // §2: partner connection — a tiny avatar so an inbound surprise visibly
  // originates from them, without a separate "your partner sent a
  // surprise" text line spelling it out. (The connecting glow that used
  // to sit here was part of the floating-card treatment being removed —
  // the avatar alone already does this job, same as it does for a normal
  // MessageBubble.)
  const originAvatar = !isMine && (
    <div className="relative h-6 w-6 shrink-0 rounded-full overflow-hidden bg-muted mt-auto mb-0.5" aria-hidden="true">
      {partnerAvatar ? (
        <img loading="lazy" decoding="async" src={partnerAvatar} alt="" className="h-full w-full object-cover" />
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
        // Pressing it tips the whole bubble back very slightly (rotateX)
        // instead of just shrinking — reads as pushing in a real embedded
        // object rather than a flat icon dimming. transformPerspective on
        // this same element is what makes that rotateX legible at all.
        whileTap={prefersReducedMotion ? undefined : { scale: 0.97, rotateX: 5 }}
        onPointerDown={() => setIsPressed(true)}
        onPointerUp={() => setIsPressed(false)}
        onPointerLeave={() => setIsPressed(false)}
        onPointerCancel={() => setIsPressed(false)}
        style={{ transformPerspective: 600 }}
        className={`
          relative max-w-[75%] rounded-2xl px-3 py-2.5 text-left overflow-hidden select-none
          ${isMine
            ? "bg-primary text-primary-foreground rounded-br-md"
            : "bg-[hsl(var(--surface-2))] text-foreground rounded-bl-md"}
        `}
      >
        <div className="relative flex items-center gap-3">
          {/* The lens — see the phase-2 note above. This is the ONLY part
              of the row that carries dimensional shading; the bubble
              shell around it stays exactly as flat as a normal message. */}
          <motion.div
            aria-hidden="true"
            className="relative h-11 w-11 shrink-0 rounded-xl overflow-hidden"
            animate={{ scale: isPressed && !prefersReducedMotion ? 0.94 : 1 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            style={{
              background: isMine
                ? `linear-gradient(155deg, hsl(0 0% 100% / 0.20), hsl(${hue} 40% 20% / 0.35))`
                : `linear-gradient(155deg, hsl(${hue} 55% 60% / 0.30), hsl(${hue} 55% 40% / 0.08))`,
              // Pressed state deepens the same two shadows rather than
              // swapping to a different effect — the lens is receding
              // further into the same socket, not changing material.
              boxShadow: isMine
                ? isPressed
                  ? "inset 0 2px 5px 0 hsl(0 0% 0% / 0.55), inset 0 -1px 0 0 hsl(0 0% 100% / 0.10)"
                  : "inset 0 1px 3px 0 hsl(0 0% 0% / 0.4), inset 0 -1px 0 0 hsl(0 0% 100% / 0.16)"
                : isPressed
                  ? "inset 0 2px 5px 0 hsl(0 0% 0% / 0.28), inset 0 -1px 0 0 hsl(0 0% 100% / 0.35)"
                  : "inset 0 1px 3px 0 hsl(0 0% 0% / 0.16), inset 0 -1px 0 0 hsl(0 0% 100% / 0.55)",
            }}
          >
            {/* Idle sheen — a slow diagonal glint for an unopened inbound
                surprise, the same "light crossing glass" grammar as the
                full reveal's pointer-driven specular sweep (see
                SurpriseReveal.tsx), just running on a fixed timer here
                rather than following a pointer/gyroscope, since this row
                needs to stay legible while scrolling past several of
                these at once. */}
            {isFresh && !prefersReducedMotion && (
              <motion.span
                aria-hidden="true"
                className="absolute inset-y-0 w-5 -skew-x-12"
                style={{ background: "linear-gradient(90deg, transparent, hsl(0 0% 100% / 0.4), transparent)" }}
                animate={{ left: ["-40%", "140%"] }}
                transition={{ duration: 2.4, repeat: Infinity, repeatDelay: 1.6, ease: "easeInOut" }}
              />
            )}
            <Gift
              className={`absolute inset-0 m-auto h-5 w-5 ${isMine ? "text-primary-foreground" : "text-primary"}`}
              style={{ filter: "drop-shadow(0 1px 1px hsl(0 0% 0% / 0.25))" }}
            />
          </motion.div>
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">
              {surprise.title || "A surprise"}
            </p>
            <p className={`text-[11px] ${isMine ? "text-primary-foreground/70" : "text-muted-foreground"}`}>
              {isMine ? "Tap to preview" : opened ? "Tap to reopen" : "Tap to open"}
            </p>
          </div>
        </div>

        <div className="relative flex items-center gap-1 justify-end mt-1.5">
          {isMine && (
            <span className="text-[10px] text-primary-foreground/70 flex items-center gap-0.5">
              {stageLabel(stage)}
              {stage === "opened" || stage === "interacting" || stage === "completed" ? (
                <CheckCheck className="h-3 w-3" />
              ) : stage === "seen" ? (
                <CheckCheck className="h-3 w-3 text-primary-foreground/50" />
              ) : (
                <Check className="h-3 w-3 text-primary-foreground/50" />
              )}
            </span>
          )}
          <span className={`text-[10px] ${isMine ? "text-primary-foreground/60" : "text-muted-foreground/70"}`}>
            {formatTime(createdAt)}
          </span>
        </div>
      </motion.button>
    </div>
  );
};

export default SurpriseMessage;

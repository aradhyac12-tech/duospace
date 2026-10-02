import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence, useMotionValue, useTransform, useMotionTemplate, useSpring, useReducedMotion, type Variants } from "framer-motion";
import { Maximize2, X, SkipForward, Gift, Heart } from "lucide-react";
import CodeSurpriseFrame from "@/components/CodeSurpriseFrame";
import { buildSurpriseDocument } from "@/lib/codeSurprises";
import { surpriseVariant, EngineSurprise } from "@/lib/surpriseEngine";
import { analyzeSurpriseContent, SurpriseHapticEngine, type SurpriseMood } from "@/lib/surpriseHaptics";
import { useDeviceTilt } from "@/hooks/useDeviceTilt";
import { useAuth } from "@/hooks/useAuth";
import { useSurpriseTouch } from "@/hooks/useSurpriseTouch";
import { DEPTH_PLANE, PARALLAX_AMPLITUDE_PX, PARALLAX_SPRING } from "@/lib/surpriseDepthPlanes";
import { sensory3dScale } from "@/lib/surpriseSensory";
import { cn } from "@/lib/utils";
import SurpriseRenderer from "@/components/surprise/SurpriseRenderer";

interface SurpriseRevealProps {
  surprise: EngineSurprise;
  visible: boolean;
  onClose: (engaged?: boolean) => void;
  /** §7: dual-activation state for this surprise, from useChatSurprise's
   *  dualActivationById — undefined until the first Couple Sync fetch
   *  lands (surprises with no activation events yet look the same either
   *  way: neither side has activated). */
  dualActivation?: { mine: boolean; partner: boolean; both: boolean };
  /** §8 (Living Photograph): bumped counter → CodeSurpriseFrame posts one
   *  ds-partner-ripple message into the frame when this changes. */
  rippleTick?: number;
}

/**
 * Two-phase presentation, both "modes" the product asked for, unified into
 * one continuous gesture instead of a picked-in-advance branch:
 *
 * Phase 1 — GLASS: a soft, translucent card blends in over the live chat,
 *   growing in slowly (like something taking root) rather than snapping in.
 * Phase 2 — TAKEOVER (tap to expand): the card grows to fill the screen,
 *   the chat fades fully out, and a lightweight WebGL scene lazy-loads in
 *   behind the surprise for surprises whose variant earns it.
 *
 * This same component wraps preset-generated documents and fully custom
 * code equally — it only ever touches html/css/js_content + title.
 */
const SurpriseReveal = ({ surprise, visible, onClose, dualActivation, rippleTick }: SurpriseRevealProps) => {
  const { user } = useAuth();
  const [expanded, setExpanded] = useState(false);
  // §8: Heart Reaction — the one partner-reaction kind that's a deliberate
  // manual send rather than an automatic lifecycle event (opened/completed
  // already fire on their own from useChatSurprise). `sent` just drives the
  // button's own brief confirmation state — the actual dedupe/idempotency
  // lives server-side (surprise_couple_sync_events' UNIQUE constraint), so
  // nothing bad happens if this local flag and the server ever disagree.
  const [heartSent, setHeartSent] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const variant = useMemo(() => surpriseVariant(surprise.id), [surprise.id]);
  // Same formula as SurpriseMessage's embedded lens, keyed off the same
  // variant.seed — this is what lets the small badge below read as the
  // SAME object that was sitting in the chat bubble a moment ago, rather
  // than a new one appearing. Content-mood tinting (accent, below) still
  // drives the card's own glow/border — that's about what's INSIDE this
  // surprise; the hue is about WHICH surprise it is, and the two aren't
  // meant to be the same signal.
  const hue = variant.seed % 200;

  // Content-pattern haptic composer (see lib/surpriseHaptics.ts — heuristic
  // scan of this surprise's own html/css/js, not a live model). Mood also
  // drives a subtle accent tint on the glow/border below, so the haptic
  // feel and the visual feel are reading the same signal rather than one
  // being generic and the other being content-aware.
  const analysis = useMemo(
    () => analyzeSurpriseContent(surprise.html_content, surprise.css_content, surprise.js_content),
    [surprise.html_content, surprise.css_content, surprise.js_content]
  );
  const moodTint: Record<SurpriseMood, string> = {
    romantic: "hsl(340 82% 62%)",
    celebratory: "hsl(var(--primary))",
    playful: "hsl(45 90% 58%)",
    calm: "hsl(200 70% 60%)",
    intense: "hsl(6 80% 58%)",
  };
  const accent = moodTint[analysis.mood];

  // Phase 3 (§12/13): the visible-effect below is this surprise's INTERACT
  // moment — SurpriseHapticEngine.ambientLoop() plays the mood's `open`
  // beat immediately (that IS the interact beat) then keeps a soft ambient
  // pulse going, paced off the surprise's own CSS animation duration, for
  // as long as the card stays open. Cancelled on unmount/surprise-change
  // so nothing from a closed surprise can fire late into whatever opens
  // next.
  const stopMovieRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!visible) return;
    stopMovieRef.current = SurpriseHapticEngine.ambientLoop(analysis.mood, analysis.contentDurationMs);
    return () => stopMovieRef.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, surprise.id]);

  // Floating emoji layer — reuses emoji actually found in the surprise's
  // own content when there are any (feels like it belongs to THIS
  // surprise), falls back to a small mood-appropriate set otherwise. Fixed
  // per-surprise positions/depths (seeded off variant.seed, same value the
  // WebGL scene already uses) so it doesn't reshuffle every re-render.
  const MOOD_FALLBACK_EMOJI: Record<SurpriseMood, string[]> = {
    romantic: ["💕", "✨"], celebratory: ["🎉", "✨"], playful: ["😄", "✨"],
    calm: ["🌙", "✨"], intense: ["🔥", "✨"],
  };
  const particleEmoji = analysis.emojisFound.length ? analysis.emojisFound.slice(0, 4) : MOOD_FALLBACK_EMOJI[analysis.mood];
  const particles = useMemo(() => {
    let rng = variant.seed || 1;
    const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
    return Array.from({ length: 7 }).map((_, i) => ({
      emoji: particleEmoji[i % particleEmoji.length],
      left: 8 + rand() * 84,
      top: 8 + rand() * 84,
      depth: rand() * 60 - 20, // translateZ, gives real parallax under the tilt below
      duration: 5 + rand() * 4,
      delay: rand() * 2,
      size: 14 + rand() * 12,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant.seed, analysis.mood]);

  // Anticipation → interaction → reveal → content → completion, but never at
  // the cost of someone who's asked the OS for less motion, or someone who
  // just wants to skip straight to the content. Both collapse every staged
  // transition below to duration 0 — the content itself is already mounted
  // either way, so nothing is ever gated behind the animation finishing.
  const prefersReducedMotion = useReducedMotion();
  const [skipped, setSkipped] = useState(false);
  const [introDone, setIntroDone] = useState(false);
  const instant = !!prefersReducedMotion || skipped;
  const skipIntro = () => { setSkipped(true); setIntroDone(true); };

  const surpriseDocument = useMemo(
    () =>
      buildSurpriseDocument({
        title: surprise.title,
        html_content: surprise.html_content,
        css_content: surprise.css_content,
        js_content: surprise.js_content,
        max_views: surprise.max_views,
      }),
    [surprise]
  );

  // Pointer-driven 3D tilt — cheap, always-on depth that doesn't need WebGL.
  // Skipped entirely under reduced motion / skip, so no lingering spring
  // physics fire from a pointer move after the person opted out of motion.
  // Range widened from ±8° to ±14° and stiffened slightly — the previous
  // tilt was subtle enough to be easy to miss; this reads as an actual
  // physical object catching light rather than a barely-there wobble.
  // §2 audit finding: depth3d/tiltResponse were persisted from the
  // Sensory Director editor but never actually read here — the exact
  // "metadata-only configuration" bug this phase calls out. Wired now:
  // tiltResponse scales how far a given tilt/pointer INPUT is allowed to
  // move anything (rotation gain), depth3d scales how far apart the
  // layers read from EACH OTHER (parallax amplitude) — two genuinely
  // different dials that happen to both end up as multipliers here.
  const { depth3d, tiltResponse } = sensory3dScale(surprise.sensory_settings);

  const rawX = useMotionValue(0);
  const rawY = useMotionValue(0);
  const rotateX = useSpring(useTransform(rawY, [-0.5, 0.5], [14 * tiltResponse, -14 * tiltResponse]), { stiffness: 140, damping: 14 });
  const rotateY = useSpring(useTransform(rawX, [-0.5, 0.5], [-14 * tiltResponse, 14 * tiltResponse]), { stiffness: 140, damping: 14 });
  // Phase 4 (§11): the same rawX/rawY driving the card's own tilt spring,
  // exposed as a plain getter for SurpriseRenderer/useAmbientScene's
  // render loop to pull from each frame. useCallback here (not an inline
  // arrow at the JSX call site) purely so the identity stays stable across
  // renders — rawX/rawY themselves never change identity either, so this
  // never needs to be recreated.
  const getTilt = useCallback(() => ({ x: rawX.get(), y: rawY.get() }), [rawX, rawY]);
  // Hoisted out of JSX: these were previously called inline inside the render
  // tree, which put them behind conditional branches (rules-of-hooks error).
  // Specular highlight — a bright diagonal streak that moves OPPOSITE the
  // tilt direction, the way a light reflection slides across real glass
  // when you rotate it. Pure CSS/motion-value math, no extra render cost.
  const specularX = useTransform(rawX, [-0.5, 0.5], ["20%", "80%"]);
  const specularY = useTransform(rawY, [-0.5, 0.5], ["80%", "20%"]);
  // BUG FIX: specularX/specularY are live MotionValues — embedding them in
  // a plain template-literal string (`...${specularX}...`) would stringify
  // the MotionValue object itself once at render time, not its current
  // number, and would never update as the pointer moves. useMotionTemplate
  // is Framer Motion's purpose-built way to interpolate MotionValues into
  // an arbitrary CSS string (here, a radial-gradient position) and keep it
  // reactively subscribed.
  const specularBackground = useMotionTemplate`radial-gradient(circle 120px at ${specularX} ${specularY}, hsl(0 0% 100% / 0.9), transparent 70%)`;

  // Phase 5 (§5): real xy parallax per depth plane, not just the card's own
  // rotation. Background drifts least, particles more, the specular
  // foreground layer moves the most — the same rawX/rawY tilt input the
  // card's rotateX/rotateY already reads, just re-scaled per plane and
  // spring-smoothed independently so layers separate instead of the whole
  // card content sliding as one flat sheet. mainObject's own depth is
  // still expressed as the card's rotation (below) rather than a second,
  // redundant translation on top of it.
  const bgParallaxX = useSpring(useTransform(rawX, [-0.5, 0.5], [-PARALLAX_AMPLITUDE_PX * DEPTH_PLANE.background * depth3d * tiltResponse, PARALLAX_AMPLITUDE_PX * DEPTH_PLANE.background * depth3d * tiltResponse]), PARALLAX_SPRING);
  const bgParallaxY = useSpring(useTransform(rawY, [-0.5, 0.5], [-PARALLAX_AMPLITUDE_PX * DEPTH_PLANE.background * depth3d * tiltResponse, PARALLAX_AMPLITUDE_PX * DEPTH_PLANE.background * depth3d * tiltResponse]), PARALLAX_SPRING);
  const particleParallaxX = useSpring(useTransform(rawX, [-0.5, 0.5], [-PARALLAX_AMPLITUDE_PX * DEPTH_PLANE.particles * depth3d * tiltResponse, PARALLAX_AMPLITUDE_PX * DEPTH_PLANE.particles * depth3d * tiltResponse]), PARALLAX_SPRING);
  const particleParallaxY = useSpring(useTransform(rawY, [-0.5, 0.5], [-PARALLAX_AMPLITUDE_PX * DEPTH_PLANE.particles * depth3d * tiltResponse, PARALLAX_AMPLITUDE_PX * DEPTH_PLANE.particles * depth3d * tiltResponse]), PARALLAX_SPRING);
  const foregroundParallaxX = useSpring(useTransform(rawX, [-0.5, 0.5], [-PARALLAX_AMPLITUDE_PX * DEPTH_PLANE.foreground * depth3d * tiltResponse, PARALLAX_AMPLITUDE_PX * DEPTH_PLANE.foreground * depth3d * tiltResponse]), PARALLAX_SPRING);
  const foregroundParallaxY = useSpring(useTransform(rawY, [-0.5, 0.5], [-PARALLAX_AMPLITUDE_PX * DEPTH_PLANE.foreground * depth3d * tiltResponse, PARALLAX_AMPLITUDE_PX * DEPTH_PLANE.foreground * depth3d * tiltResponse]), PARALLAX_SPRING);

  // Gyroscope tilt takes over from pointer tilt the moment it's actually
  // producing readings (see useDeviceTilt — this is what makes the card
  // feel like a physical object held in the hand on an actual phone,
  // where pointermove from a static finger tap doesn't behave like a
  // mouse drag). Falls back to whatever the pointer handlers below last
  // set if the device has no sensor or permission was denied.
  // Phase 4 (§11): tilt now stays live across BOTH states, not just the
  // pre-expand card. Previously this was `!expanded && !instant` — which
  // meant device tilt was explicitly torn down at exactly the moment the
  // WebGL scene mounts (richScene only renders once `expanded` is true),
  // so the one thing the brief says tilt should drive ("camera position,
  // object position, light position, particle depth, parallax" — all
  // scene-internal) was structurally starved of input the whole time it
  // was on screen. The card's own CSS rotateX/rotateY below is still
  // hard-zeroed while expanded (a full-screen surface tilting like a
  // hand-held card would look wrong) — only the SCENE reads tilt now once
  // expanded, via rawX/rawY passed to SurpriseRenderer further down.
  const deviceTilt = useDeviceTilt(!instant);
  useEffect(() => {
    if (!deviceTilt.active) return;
    rawX.set(deviceTilt.x);
    rawY.set(deviceTilt.y);
  }, [deviceTilt.active, deviceTilt.x, deviceTilt.y, rawX, rawY]);

  const handlePointerMove = (e: React.PointerEvent) => {
    if (instant || deviceTilt.active) return; // gyroscope takes over once it's actually reporting
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    rawX.set((e.clientX - rect.left) / rect.width - 0.5);
    rawY.set((e.clientY - rect.top) / rect.height - 0.5);
  };
  const handlePointerLeave = () => {
    if (deviceTilt.active) return; // gyroscope owns rawX/rawY now, don't zero it out from under it
    rawX.set(0);
    rawY.set(0);
  };
  // iOS gates DeviceOrientationEvent behind a permission prompt that must
  // be triggered from a real tap — piggybacking on the card's own
  // pointerdown means the request happens invisibly on someone's very
  // first touch of the surprise, with no separate "enable motion" prompt
  // to design or explain. No-ops everywhere else (Android/desktop).
  const handlePointerDown = () => deviceTilt.requestPermission();

  // §8: only the recipient sends a heart about a surprise, and only when
  // the creator hasn't opted their surprise out of partner reactions —
  // same two gates as the automatic opened/completed reactions in
  // useChatSurprise, kept consistent here rather than re-deriving them.
  const isMine = !!user && surprise.creator_id === user.id;
  const canSendHeart = !isMine && surprise.partner_reactions_enabled !== false;

  const sendHeart = useCallback(() => {
    if (!user || heartSent) return;
    setHeartSent(true);
    import("@/lib/coupleSync").then(({ sendPartnerReaction }) =>
      sendPartnerReaction(surprise, user.id, "heart")
    );
    // A heart is a one-shot "thinking of you" per viewing, not a toggle —
    // times out after a few seconds rather than staying sendable
    // indefinitely, and also resets whenever a different surprise opens
    // (see the surprise.id effect below).
    setTimeout(() => setHeartSent(false), 4000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, surprise, heartSent]);

  // ChatSurpriseHost doesn't remount this component between different
  // surprises (no key={surprise.id}) — without this, heartSent from one
  // surprise would still read as "already sent" on the next one opened.
  useEffect(() => { setHeartSent(false); }, [surprise.id]);

  // §7: the surprise's own content (inside the sandboxed iframe) calls
  // DuoSpaceCoupleSync.activate() → CodeSurpriseFrame's onCoupleSyncActivate
  // → here. Persists the event; the actual "both activated" detection
  // happens where dualActivation is computed (useChatSurprise), which then
  // flows back down as a prop and gets pushed back INTO the frame by
  // CodeSurpriseFrame — this component never computes activation state
  // itself, only relays it in both directions.
  const handleDualActivate = useCallback(() => {
    if (!user) return;
    import("@/lib/coupleSync").then(({ recordDualActivation }) => recordDualActivation(surprise.id, user.id));
    import("@/lib/surpriseExperienceEngine").then(({ SurpriseExperienceEngine }) =>
      SurpriseExperienceEngine.dispatch(surprise.id, "MAJOR_REVEAL", surprise)
    );
  }, [user, surprise]);

  // The actual completion climax: fires once BOTH sides have activated —
  // detected independently on each device from its own fetch of the same
  // shared rows, each firing its own local COMPLETE. The engine's own
  // once-per-surprise guard (§12/§14) is what stops this from replaying on
  // a re-fetch/reconnect once both are already true, not anything here.
  useEffect(() => {
    if (!dualActivation?.both) return;
    import("@/lib/surpriseExperienceEngine").then(({ SurpriseExperienceEngine }) =>
      SurpriseExperienceEngine.dispatch(surprise.id, "COMPLETE", surprise)
    );
  }, [dualActivation?.both, surprise]);

  // §8: content-triggered haptic — validated kind, routed through the
  // same capability-aware player everything else uses, so global haptic
  // on/off and per-tier degrade (§3) apply here too, not a side channel.
  const handleHapticRequest = useCallback((kind: string) => {
    import("@/lib/surpriseCapabilities").then(({ playCapabilityAwareSequence }) =>
      playCapabilityAwareSequence([{ kind: kind as any, delayMs: 0 }])
    );
  }, []);

  // Phase 4 (§4): factored so the physical gestures below (double-tap,
  // swipe-down) trigger the exact same expand/close path the header
  // buttons already use — one source of truth for "what expanding/closing
  // actually does", not a second copy of the haptic-dispatch + state logic.
  const doExpand = useCallback(() => {
    stopMovieRef.current?.();
    import("@/lib/surpriseExperienceEngine").then(({ SurpriseExperienceEngine }) =>
      SurpriseExperienceEngine.dispatch(surprise.id, "MAJOR_REVEAL", surprise)
    );
    // §7/§12: persist the semantic moment itself, not just its local
    // haptic/visual — this is the "sender event → persisted semantic
    // state" half of Two-Screen Heart-style sync; a partner who's offline
    // right now still finds this row waiting the next time they fetch.
    if (user) {
      import("@/lib/coupleSync").then(({ recordCoupleSyncEvent }) =>
        recordCoupleSyncEvent(surprise.id, user.id, "surprise_major_reveal")
      );
    }
    setExpanded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surprise, user]);

  const doClose = useCallback(() => {
    stopMovieRef.current?.();
    const engaged = introDone || expanded;
    import("@/lib/surpriseExperienceEngine").then(({ SurpriseExperienceEngine }) =>
      SurpriseExperienceEngine.dispatch(surprise.id, engaged ? "COMPLETE" : "CLOSE", surprise)
    );
    onClose(engaged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surprise, introDone, expanded, onClose]);

  // Phase 4 (§4): the surprise card itself now responds to touch, not just
  // its buttons — tap gives a quick confirmation pulse, a held press reads
  // as a deeper compression, a double-tap is a physical shortcut straight
  // to Expand, and a downward swipe reads as "set it down" (close). Only
  // active in the glass (non-expanded) phase and never under reduced
  // motion / skip — instant already means every OTHER staged animation is
  // suppressed, so the spring-driven compression should be too, while the
  // callbacks themselves (tap/double-tap/swipe) still fire per §17.
  const cardTouch = useSurpriseTouch({
    disablePhysicalResponse: instant,
    onTap: () => {
      import("@/lib/surpriseExperienceEngine").then(({ SurpriseExperienceEngine }) =>
        SurpriseExperienceEngine.dispatch(surprise.id, "INTERACT", surprise)
      );
      // §6: the recipient tapping is exactly "PARTNER_B interacts" from
      // the spec's own worked example — persist it so the sender can feel
      // it too. isMine-gated same as every other reaction here: previewing
      // your own sent surprise shouldn't tell yourself you're your partner.
      if (!isMine && user) {
        import("@/lib/coupleSync").then(({ recordInteraction }) => recordInteraction(surprise, user.id));
      }
    },
    onDoubleTap: () => { if (!expanded) doExpand(); },
    onSwipe: (direction) => { if (!expanded && direction === "down") doClose(); },
  });

  // Keyboard: Escape closes like the visible X button; focus starts on the
  // close control so keyboard/screen-reader users aren't dropped silently
  // into the middle of an unfamiliar overlay.
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const t = setTimeout(() => closeButtonRef.current?.focus(), instant ? 0 : 120);
    return () => { window.removeEventListener("keydown", onKey); clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Forest-style staggered growth: root glow first, then card, then content, then particles.
  const containerVariants = {
    hidden: { opacity: 0 },
    show: { opacity: 1, transition: { staggerChildren: instant ? 0 : 0.22, delayChildren: instant ? 0 : 0.05 } },
  };
  const growUp: Variants = {
    hidden: instant ? { opacity: 1, y: 0, scale: 1 } : { opacity: 0, y: 26, scale: 0.86 },
    show: {
      opacity: 1,
      y: 0,
      scale: 1,
      transition: instant ? { duration: 0 } : { duration: 1.1, ease: [0.16, 1, 0.3, 1] as const },
      // A resting `filter: blur(0px)` still forces every descendant — the
      // surprise iframe included — into an offscreen filter surface. Drop it
      // once the entrance is over so the frame composites normally.
    },
  };

  // Fresh intro state each time a new surprise opens. `expanded` is reset
  // here too — it has no remount to reset it otherwise (ChatSurpriseHost
  // keeps one persistent SurpriseReveal instance across every surprise in
  // the conversation, not one per surprise.id), so without this, Expanding
  // any ONE surprise once would leave every surprise opened afterward
  // stuck rendering the full-screen blurred `expanded` backdrop from the
  // very first frame — reported as "the screen goes blurry" when opening
  // a later surprise that was never itself expanded.
  useEffect(() => {
    if (visible) { setSkipped(false); setIntroDone(prefersReducedMotion ?? false); setExpanded(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, surprise.id]);

  // The surprise document is only MOUNTED once the entrance has finished
  // (introDone below). Mounted earlier, its CSS animations, timers and
  // one-shot effects (typewriters, fade-ins, sounds) ran for ~1.5s while the
  // card was still fading/blurring in — the person saw them already
  // half-finished. This timer is only a backstop in case the entrance
  // animation's completion callback never fires (e.g. tab throttled), so the
  // surprise can never be stuck on a blank card.
  useEffect(() => {
    if (!visible || introDone) return;
    const t = setTimeout(() => setIntroDone(true), 3500);
    return () => clearTimeout(t);
  }, [visible, introDone, surprise.id]);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label={`Surprise: ${surprise.title}`}
          // Embedded-in-chat, not a new screen: in the glass phase this no
          // longer centers over the ENTIRE viewport with a dimming scrim —
          // it anchors low, near where the composer/hub already live
          // (same --dock-reserve token GridMenu uses, so it stays correct
          // if dock sizing ever changes), with only a faint tint so the
          // chat behind it — header, message bubbles, composer — stays
          // clearly visible and readable. It genuinely reads as something
          // that appeared IN the conversation. Full-viewport takeover
          // (heavy blur, centered) is now reserved for the expanded phase
          // only — an explicit, deliberate action the person chose by
          // tapping Expand, not the default resting state.
          className={cn(
            "fixed z-[60] flex",
            expanded
              ? "inset-0 items-center justify-center px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-[max(1.25rem,env(safe-area-inset-top))] bg-background/95"
              : "inset-x-3 items-end justify-center bg-transparent"
          )}
          style={{
            ...(expanded ? {} : { bottom: "calc(env(safe-area-inset-bottom, 0px) + var(--dock-reserve) + 12px)" }),
          }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: instant ? 0 : 1.4, ease: "easeOut" } }}
          exit={{ opacity: 0, transition: { duration: instant ? 0 : 0.5 } }}
        >
          <motion.div
            ref={containerRef}
            variants={containerVariants}
            initial="hidden"
            animate="show"
            onPointerMove={handlePointerMove}
            onPointerLeave={handlePointerLeave}
            onPointerDown={handlePointerDown}
            style={{ perspective: introDone ? "none" : 1400 }}
            className={cn(
              "relative w-full ease-[cubic-bezier(0.16,1,0.3,1)]",
              instant ? "" : "transition-[max-width,max-height] duration-700",
              expanded ? "max-w-none h-full" : "max-w-[280px] max-h-[62vh]"
            )}
          >
            {/* root glow — background plane (§5): drifts LEAST of any
                layer under tilt, tinted per detected mood. */}
            <motion.div
              variants={growUp}
              className="pointer-events-none absolute -inset-6 rounded-[2rem] opacity-70"
              style={{
                background: `radial-gradient(circle at 50% 50%, ${accent}55, transparent 65%)`,
                x: bgParallaxX,
                y: bgParallaxY,
              }}
            />

            {/* idle float — a slow, continuous drift when the card isn't
                being actively tilted by a pointer, on its own layer so it
                composes with (rather than fights) the pointer-driven
                rotateX/rotateY spring on the card below. */}
            <motion.div
              // Float only during the intro. Once the iframe is mounted a
              // perpetual fractional-px transform keeps it on a moving,
              // re-rasterised layer, which reads as blurry text/graphics.
              animate={!expanded && !instant && !introDone ? { y: [0, -7, 0] } : { y: 0 }}
              transition={!expanded && !instant && !introDone ? { y: { duration: 4.5, repeat: Infinity, ease: "easeInOut" } } : { duration: 0 }}
              className="relative h-full"
            >
              <motion.div
                variants={growUp}
                {...(!expanded ? cardTouch.handlers : {})}
                style={{
                  rotateX: expanded || introDone ? 0 : rotateX, rotateY: expanded || introDone ? 0 : rotateY,
                  transformStyle: introDone ? "flat" : "preserve-3d",
                  // mainObject plane (§5): rotation IS this layer's depth
                  // expression — adding a second xy translation on top
                  // would be a redundant, busier version of the same
                  // signal. Physical touch response (§4): scale dips on
                  // press/hold and overshoots slightly on release, via
                  // useSurpriseTouch's spring-smoothed compression value.
                  scale: expanded || introDone ? 1 : cardTouch.compression,
                  boxShadow: "var(--shadow-glass)",
                  borderColor: expanded ? undefined : `${accent}30`,
                }}
                className={cn(
                  "relative flex h-full flex-col overflow-hidden border",
                  expanded
                    ? "rounded-2xl border-border/20 bg-background/70"
                    : "rounded-panel bg-background/90 touch-none"
                )}
              >
                {variant.richScene && expanded && !instant && (
                  <div className="absolute inset-0 -z-10">
                    <SurpriseRenderer mood={analysis.mood} seed={variant.seed} getTilt={getTilt} tiltResponse={tiltResponse} />
                  </div>
                )}

                {/* specular sweep — a bright diagonal streak that slides
                    opposite the tilt direction, like a light reflection
                    crossing real glass. transformStyle:preserve-3d on the
                    parent + a translateZ here gives it real depth
                    separation from the content underneath rather than
                    just being a flat overlay. */}
                {!expanded && !instant && !introDone && (
                  <motion.div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 z-20 opacity-40 mix-blend-overlay"
                    style={{
                      transform: "translateZ(40px)",
                      background: specularBackground,
                      x: foregroundParallaxX,
                      y: foregroundParallaxY,
                    }}
                  />
                )}

                {/* floating emoji layer — particles plane (§5): each
                    particle sits at its own translateZ (depth separation
                    from the preserve-3d tilt above) AND now shares one
                    xy parallax offset for the whole layer (its plane
                    multiplier, 0.4x) so it visibly separates from both the
                    background glow behind it and the foreground specular
                    sweep in front of it under tilt. */}
                {!expanded && !instant && (
                  <motion.div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
                    style={{ x: particleParallaxX, y: particleParallaxY }}
                  >
                    {particles.map((p, i) => (
                      <motion.span
                        key={i}
                        className="absolute select-none"
                        style={{
                          left: `${p.left}%`, top: `${p.top}%`, fontSize: p.size,
                          transform: `translateZ(${p.depth}px)`,
                          filter: p.depth < 0 ? "blur(1px)" : "none",
                          opacity: 0.85 - Math.abs(p.depth) / 120,
                        }}
                        animate={{ y: [0, -10, 0], opacity: [0, 0.85 - Math.abs(p.depth) / 120, 0.85 - Math.abs(p.depth) / 120, 0] }}
                        transition={{ duration: p.duration, delay: p.delay, repeat: Infinity, ease: "easeInOut" }}
                      >
                        {p.emoji}
                      </motion.span>
                    ))}
                  </motion.div>
                )}

                <div className="relative z-30 flex items-center justify-between px-4 pt-3">
                  <div className="flex items-center gap-2 min-w-0">
                    {/* Continuity badge: the exact same recessed-lens
                        treatment (gradient + inset shadow pair) as the
                        embedded row in the chat, same hue, same Gift
                        glyph — so opening this card reads as that same
                        small object growing into the space, not a
                        different card replacing it. Only shown pre-
                        expand; the takeover phase has its own full scene
                        doing this job instead. */}
                    {!expanded && (
                      <div
                        aria-hidden="true"
                        className="relative h-7 w-7 shrink-0 rounded-lg overflow-hidden"
                        style={{
                          background: `linear-gradient(155deg, hsl(${hue} 55% 60% / 0.30), hsl(${hue} 55% 40% / 0.08))`,
                          boxShadow: "inset 0 1px 3px 0 hsl(0 0% 0% / 0.16), inset 0 -1px 0 0 hsl(0 0% 100% / 0.55)",
                        }}
                      >
                        <Gift className="absolute inset-0 m-auto h-3.5 w-3.5 text-primary" />
                      </div>
                    )}
                    <p className="text-sm font-semibold drop-shadow-sm truncate">{surprise.title}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {!introDone && (
                      <button
                        onClick={skipIntro}
                        onPointerDown={(e) => e.stopPropagation()}
                        className="h-10 rounded-full bg-muted/70 px-3 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground"
                        aria-label="Skip intro animation"
                      >
                        <SkipForward className="h-3 w-3" /> Skip
                      </button>
                    )}
                    {canSendHeart && (
                      <button
                        onClick={sendHeart}
                        onPointerDown={(e) => e.stopPropagation()}
                        disabled={heartSent}
                        aria-label={heartSent ? "Heart sent" : "Send a heart reaction to your partner"}
                        aria-pressed={heartSent}
                        className="h-10 w-10 rounded-full bg-muted/70 flex items-center justify-center disabled:opacity-70"
                      >
                        <Heart className={`h-4 w-4 transition-colors ${heartSent ? "text-red-500 fill-red-500" : "text-muted-foreground"}`} />
                      </button>
                    )}
                    {!expanded && (
                      <button
                        onClick={doExpand}
                        onPointerDown={(e) => e.stopPropagation()}
                        className="h-10 w-10 rounded-full bg-muted/70 flex items-center justify-center"
                        aria-label="Expand surprise"
                      >
                        <Maximize2 className="h-3.5 w-3.5 text-muted-foreground" />
                      </button>
                    )}
                    <button
                      ref={closeButtonRef}
                      onClick={doClose}
                      onPointerDown={(e) => e.stopPropagation()}
                      className="h-10 w-10 rounded-full bg-muted/70 flex items-center justify-center"
                      aria-label="Close surprise"
                    >
                      <X className="h-4 w-4 text-muted-foreground" />
                    </button>
                  </div>
                </div>

                <motion.div
                  variants={growUp}
                  onAnimationComplete={() => setIntroDone(true)}
                  // Glass phase: the card has no definite height, so the
                  // iframe's `h-full` used to resolve to auto = the 150px
                  // default frame height — every surprise was squeezed into
                  // a ~254×150 window (100vh inside it = 150px). Give the
                  // content area a real height there; expanded keeps
                  // flex-1 inside its full-height column.
                  className={cn("relative z-30 p-3", expanded ? "flex-1 min-h-0" : "h-[min(46vh,340px)] flex-none")}
                >
                  {introDone ? (
                    <CodeSurpriseFrame
                      documentHtml={surpriseDocument}
                      title={surprise.title}
                      coupleSyncState={dualActivation}
                      onCoupleSyncActivate={handleDualActivate}
                      onHapticRequest={handleHapticRequest}
                      rippleTick={rippleTick}
                    />
                  ) : (
                    <div aria-hidden="true" className="h-full w-full rounded-2xl bg-muted/20" />
                  )}
                </motion.div>
              </motion.div>
            </motion.div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default SurpriseReveal;

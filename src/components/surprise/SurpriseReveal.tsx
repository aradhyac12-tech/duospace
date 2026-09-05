import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence, useMotionValue, useTransform, useMotionTemplate, useSpring, useReducedMotion, type Variants } from "framer-motion";
import { Maximize2, X, SkipForward, Gift } from "lucide-react";
import CodeSurpriseFrame from "@/components/CodeSurpriseFrame";
import { buildSurpriseDocument } from "@/lib/codeSurprises";
import { surpriseVariant, EngineSurprise } from "@/lib/surpriseEngine";
import { analyzeSurpriseContent, SurpriseHapticEngine, type SurpriseMood } from "@/lib/surpriseHaptics";
import { useDeviceTilt } from "@/hooks/useDeviceTilt";
import { cn } from "@/lib/utils";
import SurpriseRenderer from "@/components/surprise/SurpriseRenderer";

interface SurpriseRevealProps {
  surprise: EngineSurprise;
  visible: boolean;
  onClose: () => void;
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
const SurpriseReveal = ({ surprise, visible, onClose }: SurpriseRevealProps) => {
  const [expanded, setExpanded] = useState(false);
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
  const rawX = useMotionValue(0);
  const rawY = useMotionValue(0);
  const rotateX = useSpring(useTransform(rawY, [-0.5, 0.5], [14, -14]), { stiffness: 140, damping: 14 });
  const rotateY = useSpring(useTransform(rawX, [-0.5, 0.5], [-14, 14]), { stiffness: 140, damping: 14 });
  // Phase 4 (§11): the same rawX/rawY driving the card's own tilt spring,
  // exposed as a plain getter for SurpriseRenderer/useAmbientScene's
  // render loop to pull from each frame. useCallback here (not an inline
  // arrow at the JSX call site) purely so the identity stays stable across
  // renders — rawX/rawY themselves never change identity either, so this
  // never needs to be recreated.
  const getTilt = useCallback(() => ({ x: rawX.get(), y: rawY.get() }), [rawX, rawY]);
  // Hoisted out of JSX: these were previously called inline inside the render
  // tree, which put them behind conditional branches (rules-of-hooks error).
  const glowX = useTransform(rawX, [-0.5, 0.5], [-14, 14]);
  const glowY = useTransform(rawY, [-0.5, 0.5], [-14, 14]);
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
    hidden: instant ? { opacity: 1, y: 0, scale: 1, filter: "blur(0px)" } : { opacity: 0, y: 26, scale: 0.86, filter: "blur(10px)" },
    show: {
      opacity: 1,
      y: 0,
      scale: 1,
      filter: "blur(0px)",
      transition: instant ? { duration: 0 } : { duration: 1.1, ease: [0.16, 1, 0.3, 1] as const },
    },
  };

  // Fresh intro state each time a new surprise opens.
  useEffect(() => {
    if (visible) { setSkipped(false); setIntroDone(prefersReducedMotion ?? false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, surprise.id]);

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
            backdropFilter: expanded ? "blur(28px)" : "none",
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
            style={{ perspective: 1400 }}
            className={cn(
              "relative w-full ease-[cubic-bezier(0.16,1,0.3,1)]",
              instant ? "" : "transition-[max-width,max-height] duration-700",
              expanded ? "max-w-none h-full" : "max-w-[280px] max-h-[62vh]"
            )}
          >
            {/* root glow — the first thing to take root, drifts gently with pointer, tinted per detected mood */}
            <motion.div
              variants={growUp}
              className="pointer-events-none absolute -inset-6 rounded-[2rem] opacity-70"
              style={{
                filter: "blur(30px)",
                background: `radial-gradient(circle at 50% 50%, ${accent}55, transparent 65%)`,
                x: glowX,
                y: glowY,
              }}
            />

            {/* idle float — a slow, continuous drift when the card isn't
                being actively tilted by a pointer, on its own layer so it
                composes with (rather than fights) the pointer-driven
                rotateX/rotateY spring on the card below. */}
            <motion.div
              animate={!expanded && !instant ? { y: [0, -7, 0] } : { y: 0 }}
              transition={!expanded && !instant ? { y: { duration: 4.5, repeat: Infinity, ease: "easeInOut" } } : undefined}
              className="relative h-full"
            >
              <motion.div
                variants={growUp}
                style={{
                  rotateX: expanded ? 0 : rotateX, rotateY: expanded ? 0 : rotateY, transformStyle: "preserve-3d",
                  boxShadow: "var(--shadow-glass)",
                  borderColor: expanded ? undefined : `${accent}30`,
                }}
                className={cn(
                  "relative flex h-full flex-col overflow-hidden border",
                  expanded
                    ? "rounded-2xl border-border/20 bg-background/70"
                    : "rounded-panel bg-background/55 backdrop-blur-2xl"
                )}
              >
                {variant.richScene && expanded && !instant && (
                  <div className="absolute inset-0 -z-10">
                    <SurpriseRenderer mood={analysis.mood} seed={variant.seed} getTilt={getTilt} />
                  </div>
                )}

                {/* specular sweep — a bright diagonal streak that slides
                    opposite the tilt direction, like a light reflection
                    crossing real glass. transformStyle:preserve-3d on the
                    parent + a translateZ here gives it real depth
                    separation from the content underneath rather than
                    just being a flat overlay. */}
                {!expanded && !instant && (
                  <motion.div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 z-20 opacity-40 mix-blend-overlay"
                    style={{
                      transform: "translateZ(40px)",
                      background: specularBackground,
                    }}
                  />
                )}

                {/* floating emoji layer — content-derived where the
                    surprise has its own emoji, mood-derived otherwise.
                    Each particle sits at a different translateZ so the
                    preserve-3d tilt above genuinely separates them into
                    layers instead of one flat sticker sheet. */}
                {!expanded && !instant && (
                  <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
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
                  </div>
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
                        className="h-10 rounded-full bg-muted/70 px-3 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground"
                        aria-label="Skip intro animation"
                      >
                        <SkipForward className="h-3 w-3" /> Skip
                      </button>
                    )}
                    {!expanded && (
                      <button
                        onClick={() => {
                          // Stop the ambient loop and hand off to
                          // MAJOR_REVEAL — committing to the full-screen
                          // experience is its own moment, distinct from
                          // (and bigger than) the interact beat. Without
                          // stopping the loop first, the ambient interval
                          // would keep firing underneath it and muddy it.
                          stopMovieRef.current?.();
                          import("@/lib/surpriseHaptics").then(({ SurpriseHapticEngine }) => SurpriseHapticEngine.majorReveal(analysis.mood));
                          setExpanded(true);
                        }}
                        className="h-10 w-10 rounded-full bg-muted/70 flex items-center justify-center"
                        aria-label="Expand surprise"
                      >
                        <Maximize2 className="h-3.5 w-3.5 text-muted-foreground" />
                      </button>
                    )}
                    <button
                      ref={closeButtonRef}
                      onClick={() => {
                        // COMPLETE (an affirming beat) once they've
                        // actually engaged — intro finished/skipped, or
                        // they went full-screen. CLOSE (the plainer beat)
                        // if they bailed before the intro even played —
                        // e.g. previewing their own sent surprise, or an
                        // immediate dismiss. Either way this is the one
                        // beat that should never be loud regardless of
                        // mood, since it plays as they're already leaving.
                        stopMovieRef.current?.();
                        const engaged = introDone || expanded;
                        import("@/lib/surpriseHaptics").then(({ SurpriseHapticEngine }) =>
                          engaged ? SurpriseHapticEngine.complete(analysis.mood) : SurpriseHapticEngine.close(analysis.mood)
                        );
                        onClose();
                      }}
                      className="h-10 w-10 rounded-full bg-muted/70 flex items-center justify-center"
                      aria-label="Close surprise"
                    >
                      <X className="h-4 w-4 text-muted-foreground" />
                    </button>
                  </div>
                </div>

                <motion.div variants={growUp} onAnimationComplete={() => setIntroDone(true)} className="relative z-30 flex-1 p-3">
                  <CodeSurpriseFrame documentHtml={surpriseDocument} title={surprise.title} />
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

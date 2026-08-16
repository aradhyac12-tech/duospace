import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence, useMotionValue, useTransform, useSpring, useReducedMotion, type Variants } from "framer-motion";
import { Maximize2, X, SkipForward } from "lucide-react";
import CodeSurpriseFrame from "@/components/CodeSurpriseFrame";
import { buildSurpriseDocument } from "@/lib/codeSurprises";
import { surpriseVariant, EngineSurprise } from "@/lib/surpriseEngine";
import { hapticLight, hapticSelection } from "@/lib/haptics";
import { cn } from "@/lib/utils";

const SurpriseScene3D = lazy(() => import("@/components/surprise/SurpriseScene3D"));

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

  // Anticipation → interaction → reveal → content → completion, but never at
  // the cost of someone who's asked the OS for less motion, or someone who
  // just wants to skip straight to the content. Both collapse every staged
  // transition below to duration 0 — the content itself is already mounted
  // either way, so nothing is ever gated behind the animation finishing.
  const prefersReducedMotion = useReducedMotion();
  const [skipped, setSkipped] = useState(false);
  const [introDone, setIntroDone] = useState(false);
  const instant = !!prefersReducedMotion || skipped;
  const skipIntro = () => { hapticSelection(); setSkipped(true); setIntroDone(true); };

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
  const rawX = useMotionValue(0);
  const rawY = useMotionValue(0);
  const rotateX = useSpring(useTransform(rawY, [-0.5, 0.5], [8, -8]), { stiffness: 120, damping: 16 });
  const rotateY = useSpring(useTransform(rawX, [-0.5, 0.5], [-8, 8]), { stiffness: 120, damping: 16 });
  // Hoisted out of JSX: these were previously called inline inside the render
  // tree, which put them behind conditional branches (rules-of-hooks error).
  const glowX = useTransform(rawX, [-0.5, 0.5], [-14, 14]);
  const glowY = useTransform(rawY, [-0.5, 0.5], [-14, 14]);

  const handlePointerMove = (e: React.PointerEvent) => {
    if (expanded || instant) return; // full takeover / reduced-motion holds a fixed, resting depth
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    rawX.set((e.clientX - rect.left) / rect.width - 0.5);
    rawY.set((e.clientY - rect.top) / rect.height - 0.5);
  };
  const handlePointerLeave = () => {
    rawX.set(0);
    rawY.set(0);
  };

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
          className={cn(
            "fixed inset-0 z-[100] flex items-center justify-center px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-[max(1.25rem,env(safe-area-inset-top))]",
            expanded ? "bg-background/95" : "bg-background/20"
          )}
          style={{ backdropFilter: expanded ? "blur(28px)" : "blur(14px)" }}
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
            style={{ perspective: 1400 }}
            className={cn(
              "relative w-full ease-[cubic-bezier(0.16,1,0.3,1)]",
              instant ? "" : "transition-[max-width,max-height] duration-700",
              expanded ? "max-w-none h-full" : "max-w-sm max-h-[70vh]"
            )}
          >
            {/* root glow — the first thing to take root, drifts gently with pointer */}
            <motion.div
              variants={growUp}
              className="pointer-events-none absolute -inset-6 rounded-[2rem] opacity-70"
              style={{
                filter: "blur(30px)",
                background: "radial-gradient(circle at 50% 50%, hsl(var(--primary)/0.35), transparent 65%)",
                x: glowX,
                y: glowY,
              }}
            />

            <motion.div
              variants={growUp}
              style={{
                rotateX: expanded ? 0 : rotateX, rotateY: expanded ? 0 : rotateY, transformStyle: "preserve-3d",
                boxShadow: "var(--shadow-glass)",
              }}
              className={cn(
                "relative flex h-full flex-col overflow-hidden border",
                expanded
                  ? "rounded-2xl border-border/20 bg-background/70"
                  : "rounded-[1.75rem] border-foreground/10 bg-background/55 backdrop-blur-2xl"
              )}
            >
              {variant.richScene && expanded && !instant && (
                <div className="absolute inset-0 -z-10">
                  <Suspense fallback={null}>
                    <SurpriseScene3D seed={variant.seed} />
                  </Suspense>
                </div>
              )}

              <div className="flex items-center justify-between px-4 pt-3">
                <p className="text-sm font-semibold drop-shadow-sm">{surprise.title}</p>
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
                      onClick={() => { hapticLight(); setExpanded(true); }}
                      className="h-10 w-10 rounded-full bg-muted/70 flex items-center justify-center"
                      aria-label="Expand surprise"
                    >
                      <Maximize2 className="h-3.5 w-3.5 text-muted-foreground" />
                    </button>
                  )}
                  <button
                    ref={closeButtonRef}
                    onClick={() => { hapticLight(); onClose(); }}
                    className="h-10 w-10 rounded-full bg-muted/70 flex items-center justify-center"
                    aria-label="Close surprise"
                  >
                    <X className="h-4 w-4 text-muted-foreground" />
                  </button>
                </div>
              </div>

              <motion.div variants={growUp} onAnimationComplete={() => setIntroDone(true)} className="flex-1 p-3">
                <CodeSurpriseFrame documentHtml={surpriseDocument} title={surprise.title} />
              </motion.div>
            </motion.div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default SurpriseReveal;

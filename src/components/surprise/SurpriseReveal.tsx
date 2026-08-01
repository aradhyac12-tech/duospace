import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence, useMotionValue, useTransform, useSpring, type Variants } from "framer-motion";
import { Maximize2, X } from "lucide-react";
import CodeSurpriseFrame from "@/components/CodeSurpriseFrame";
import { buildSurpriseDocument } from "@/lib/codeSurprises";
import { surpriseVariant, EngineSurprise } from "@/lib/surpriseEngine";
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
  const variant = useMemo(() => surpriseVariant(surprise.id), [surprise.id]);

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
  const rawX = useMotionValue(0);
  const rawY = useMotionValue(0);
  const rotateX = useSpring(useTransform(rawY, [-0.5, 0.5], [8, -8]), { stiffness: 120, damping: 16 });
  const rotateY = useSpring(useTransform(rawX, [-0.5, 0.5], [-8, 8]), { stiffness: 120, damping: 16 });

  const handlePointerMove = (e: React.PointerEvent) => {
    if (expanded) return; // full takeover holds a fixed, resting depth
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    rawX.set((e.clientX - rect.left) / rect.width - 0.5);
    rawY.set((e.clientY - rect.top) / rect.height - 0.5);
  };
  const handlePointerLeave = () => {
    rawX.set(0);
    rawY.set(0);
  };

  // Forest-style staggered growth: root glow first, then card, then content, then particles.
  const containerVariants = {
    hidden: { opacity: 0 },
    show: { opacity: 1, transition: { staggerChildren: 0.22, delayChildren: 0.05 } },
  };
  const growUp: Variants = {
    hidden: { opacity: 0, y: 26, scale: 0.86, filter: "blur(10px)" },
    show: {
      opacity: 1,
      y: 0,
      scale: 1,
      filter: "blur(0px)",
      transition: { duration: 1.1, ease: [0.16, 1, 0.3, 1] as const },
    },
  };

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className={cn(
            "fixed inset-0 z-[100] flex items-center justify-center px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-[max(1.25rem,env(safe-area-inset-top))]",
            expanded ? "bg-background/95" : "bg-background/20"
          )}
          style={{ backdropFilter: expanded ? "blur(28px)" : "blur(14px)" }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: 1.4, ease: "easeOut" } }}
          exit={{ opacity: 0, transition: { duration: 0.5 } }}
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
              "relative w-full transition-[max-width,max-height] duration-700 ease-[cubic-bezier(0.16,1,0.3,1)]",
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
                x: useTransform(rawX, [-0.5, 0.5], [-14, 14]),
                y: useTransform(rawY, [-0.5, 0.5], [-14, 14]),
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
              {variant.richScene && expanded && (
                <div className="absolute inset-0 -z-10">
                  <Suspense fallback={null}>
                    <SurpriseScene3D seed={variant.seed} />
                  </Suspense>
                </div>
              )}

              <div className="flex items-center justify-between px-4 pt-3">
                <p className="text-sm font-semibold drop-shadow-sm">{surprise.title}</p>
                <div className="flex items-center gap-2">
                  {!expanded && (
                    <button
                      onClick={() => setExpanded(true)}
                      className="h-10 w-10 rounded-full bg-muted/70 flex items-center justify-center"
                      aria-label="Expand surprise"
                    >
                      <Maximize2 className="h-3.5 w-3.5 text-muted-foreground" />
                    </button>
                  )}
                  <button
                    onClick={onClose}
                    className="h-10 w-10 rounded-full bg-muted/70 flex items-center justify-center"
                    aria-label="Close surprise"
                  >
                    <X className="h-4 w-4 text-muted-foreground" />
                  </button>
                </div>
              </div>

              <motion.div variants={growUp} className="flex-1 p-3">
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

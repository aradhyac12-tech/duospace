import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

interface SplashScreenProps {
  appName?: string;
  onComplete: () => void;
}

/**
 * The tagline translated into each language — close, natural renderings of
 * "The private space for two of you" rather than mechanical word-for-word
 * substitutions. `wide` marks scripts where generous Latin-style
 * letter-spacing reads as premium; CJK/Arabic/Devanagari skip it (extra
 * tracking breaks those glyphs instead of flattering them).
 */
const TAGLINES: Array<{ text: string; code: string; dir?: "rtl"; wide?: boolean }> = [
  { text: "The private space for two of you", code: "en", wide: true },
  { text: "L'espace privé pour vous deux", code: "fr", wide: true },
  { text: "二人だけのプライベート空間", code: "ja" },
  { text: "El espacio privado para ustedes dos", code: "es", wide: true },
  { text: "المساحة الخاصة بكما أنتما فقط", code: "ar", dir: "rtl" },
  { text: "The private space for two of you", code: "en", wide: true },
];

// --- Timing ---
// This exact rhythm (STEP / CROSSFADE / FINAL_HOLD / EXIT, in seconds) was
// hand-built and verified as a real keyframed timeline in Figma before
// being ported here — a Figma "Motion" timeline of this same composition
// (Root > BG, Glow, LogoCard, NameRow, TaglineBox[6 stacked language
// layers]) uses identical values, so the pacing here isn't guesswork.
const STEP_MS = 1150;       // how long each language is the "active" one
const CROSSFADE_MS = 480;   // outgoing + incoming overlap simultaneously (true dissolve)
const FINAL_HOLD_MS = 850;  // extra hold on the final English line before exiting
const EXIT_DURATION_MS = 550;

// One easing curve, reused everywhere — the same curve iOS uses for sheet
// transitions. Repetition of a single curve is what makes a sequence of
// small motions read as one coherent design instead of a pile of effects.
const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

function useTimeout(callback: () => void, ms: number, deps: unknown[]) {
  useEffect(() => {
    const id = window.setTimeout(callback, ms);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/**
 * One-time cinematic boot splash — a single, continuous composition: the
 * logo and name appear once and hold still for the whole sequence, the
 * translated tagline dissolves beneath them, and everything fades out
 * together at the end.
 *
 * On blur and performance, together: blur IS used here (a real dissolve,
 * not a flat cut), but scoped deliberately —
 *  - It only ever animates on the small two-line tagline text, never on a
 *    large shape. Cost scales with the pixel area being blurred, so this
 *    is cheap; a full-screen or big-circle blur animation is not, and
 *    that (not blur itself) is what made earlier drafts feel laggy.
 *  - The crossfade uses AnimatePresence `mode="sync"`, so the outgoing and
 *    incoming sentence animate *simultaneously* — a true dissolve.
 *    `mode="wait"` runs them sequentially with a dead gap in between,
 *    which reads as a stutter no matter how good the easing curve is.
 *  - The tagline sits in a fixed-height, fixed-width frame so sentences of
 *    very different lengths across languages never reflow the layout.
 *  - Nothing else animates blur, color, or box-shadow — only opacity,
 *    transform, and this one small filter — so there's only ever one
 *    expensive-ish thing happening on screen at a time.
 */
const SplashScreen = ({ appName = "DuoSpace", onComplete }: SplashScreenProps) => {
  const [taglineIndex, setTaglineIndex] = useState(0);
  const [exiting, setExiting] = useState(false);
  const cancelledRef = useRef(false);

  useEffect(() => () => { cancelledRef.current = true; }, []);

  // Advance through the translated taglines on a steady, even beat.
  useEffect(() => {
    if (taglineIndex >= TAGLINES.length - 1) return;
    const id = window.setTimeout(() => {
      if (!cancelledRef.current) setTaglineIndex((i) => i + 1);
    }, STEP_MS);
    return () => window.clearTimeout(id);
  }, [taglineIndex]);

  // Once the last (English) tagline has held for a beat, fade everything
  // out together and hand back control.
  const totalHoldMs = (TAGLINES.length - 1) * STEP_MS + FINAL_HOLD_MS;
  useTimeout(() => { if (!cancelledRef.current) setExiting(true); }, totalHoldMs, []);
  useTimeout(() => { if (!cancelledRef.current) onComplete(); }, totalHoldMs + EXIT_DURATION_MS, []);

  const nameWords = appName.split(" ");
  const current = TAGLINES[taglineIndex];

  return (
    <motion.div
      className="fixed inset-0 z-[999] flex flex-col items-center justify-center overflow-hidden px-8"
      style={{ background: "radial-gradient(120% 90% at 50% 32%, #17171b 0%, #0a0a0c 60%, #050506 100%)" }}
      animate={{ opacity: exiting ? 0 : 1, scale: exiting ? 1.02 : 1 }}
      transition={{ duration: EXIT_DURATION_MS / 1000, ease: EASE }}
    >
      {/* Static ambient glow behind the logo. A very slow, subtle breathing
          scale gives it life without ever touching blur/color/layout — a
          transform-only loop is effectively free to animate. */}
      <motion.div
        className="pointer-events-none absolute h-72 w-72 rounded-full bg-white/[0.05] blur-3xl"
        style={{ top: "26%" }}
        animate={{ scale: [1, 1.06, 1] }}
        transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
      />

      <motion.div
        className="flex flex-col items-center"
        initial={{ opacity: 0, scale: 0.92 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.6, ease: EASE }}
      >
        <div className="h-20 w-20 overflow-hidden rounded-[22px] shadow-[0_8px_40px_rgba(0,0,0,0.5)]">
          <img src="/icon-1024.png" alt="" className="h-full w-full object-cover" draggable={false} />
        </div>

        <motion.div
          className="mt-5 flex gap-2"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.2, ease: EASE }}
        >
          {nameWords.map((word, i) => (
            <span key={word + i} className="text-[22px] font-semibold tracking-tight text-white">
              {word}
            </span>
          ))}
        </motion.div>

        {/* Fixed-size frame: prevents the whole composition from reflowing
            as sentence length varies between languages. The crossfade
            itself lives entirely inside this box. */}
        <div className="relative mt-3 flex h-[4.4em] w-[78vw] max-w-[360px] items-start justify-center overflow-hidden sm:w-[420px]">
          <AnimatePresence mode="sync">
            <motion.p
              key={taglineIndex}
              dir={current.dir}
              lang={current.code}
              className={[
                "absolute inset-x-0 top-0 text-center text-[14px] font-light leading-[1.45] text-white/45",
                current.wide ? "tracking-wide" : "tracking-normal",
              ].join(" ")}
              initial={{ opacity: 0, y: 6, filter: "blur(6px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: -6, filter: "blur(6px)" }}
              transition={{ duration: CROSSFADE_MS / 1000, ease: EASE }}
            >
              {current.text}
            </motion.p>
          </AnimatePresence>
        </div>
      </motion.div>
    </motion.div>
  );
};

export default SplashScreen;

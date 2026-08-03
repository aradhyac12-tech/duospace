import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";

interface SplashScreenProps {
  appName?: string;
  onComplete: () => void;
}

/**
 * Timing. The previous version cycled six translated taglines at 1.15s each
 * and took ~6.6s before the app appeared — that is what made launch feel
 * slow. A launch splash should read as a *handoff*, not a intro sequence:
 * everything below is tuned so the whole thing is on screen for well under
 * two seconds while still feeling deliberate and expensive.
 */
const ENTRANCE_MS = 520;   // logo + wordmark settle
const HOLD_MS = 620;       // the still, confident beat
const EXIT_MS = 380;       // hand off to the app
const TOTAL_MS = ENTRANCE_MS + HOLD_MS;

// One easing curve everywhere (iOS sheet curve). Reusing a single curve is
// what makes a set of small motions read as one coherent piece.
const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

const TAGLINE = "The private space for two of you";

/**
 * Premium boot splash — a single continuous composition:
 *  - deep graphite field with a soft, slowly breathing glow
 *  - the app icon lifts in with a scale/shadow settle
 *  - a fine specular sweep travels once across the wordmark
 *  - the tagline rises beneath it
 *  - everything leaves together, scaling up very slightly, so the app
 *    underneath feels like it was there all along
 *
 * Performance: only opacity and transform animate (the glow's breathing is a
 * transform-only loop, the sweep is a translated gradient behind a mask).
 * No animated blur, color, or box-shadow — it stays smooth on low-end Android.
 */
const SplashScreen = ({ appName = "DuoSpace", onComplete }: SplashScreenProps) => {
  const [exiting, setExiting] = useState(false);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    const t1 = window.setTimeout(() => { if (!cancelled.current) setExiting(true); }, TOTAL_MS);
    const t2 = window.setTimeout(() => { if (!cancelled.current) onComplete(); }, TOTAL_MS + EXIT_MS);
    return () => {
      cancelled.current = true;
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <motion.div
      className="fixed inset-0 z-[999] flex flex-col items-center justify-center overflow-hidden px-8"
      style={{ background: "radial-gradient(120% 90% at 50% 34%, #18181d 0%, #0a0a0c 58%, #050506 100%)" }}
      animate={{ opacity: exiting ? 0 : 1, scale: exiting ? 1.03 : 1 }}
      transition={{ duration: EXIT_MS / 1000, ease: EASE }}
    >
      {/* Ambient glow — transform-only breathing loop. */}
      <motion.div
        className="pointer-events-none absolute h-80 w-80 rounded-full bg-white/[0.055] blur-3xl"
        style={{ top: "24%" }}
        initial={{ scale: 0.85, opacity: 0 }}
        animate={{ scale: [0.94, 1.05, 0.98], opacity: 1 }}
        transition={{ duration: 3.2, ease: "easeInOut", repeat: Infinity, repeatType: "mirror" }}
      />

      <div className="relative flex flex-col items-center">
        {/* Icon */}
        <motion.div
          className="h-[84px] w-[84px] overflow-hidden rounded-[24px] ring-1 ring-white/10"
          style={{ boxShadow: "0 20px 60px -18px rgba(0,0,0,0.85), inset 0 1px 0 rgba(255,255,255,0.08)" }}
          initial={{ opacity: 0, scale: 0.86, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: ENTRANCE_MS / 1000, ease: EASE }}
        >
          <img src="/icon-1024.png" alt="" className="h-full w-full object-cover" draggable={false} />
        </motion.div>

        {/* Wordmark with a single specular sweep. The sweep is a translated
            gradient clipped to the text via background-clip, so nothing
            expensive (blur/filter) animates. */}
        <motion.div
          className="relative mt-6 overflow-hidden"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.44, delay: 0.12, ease: EASE }}
        >
          <span className="text-[23px] font-semibold tracking-[-0.02em] text-white/95">
            {appName}
          </span>
          <motion.span
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "linear-gradient(100deg, transparent 35%, rgba(255,255,255,0.85) 50%, transparent 65%)",
              mixBlendMode: "overlay",
            }}
            initial={{ x: "-120%" }}
            animate={{ x: "120%" }}
            transition={{ duration: 0.9, delay: 0.3, ease: [0.4, 0, 0.2, 1] }}
          />
        </motion.div>

        {/* Tagline */}
        <motion.p
          lang="en"
          className="mt-2.5 max-w-[300px] text-center text-[13.5px] font-light leading-[1.45] tracking-wide text-white/45"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.42, delay: 0.24, ease: EASE }}
        >
          {TAGLINE}
        </motion.p>

        {/* Hairline progress cue — a thin line that fills once, giving the
            hold beat a reason to exist instead of feeling like a pause. */}
        <motion.div
          className="mt-7 h-px w-24 overflow-hidden rounded-full bg-white/10"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3, delay: 0.3 }}
        >
          <motion.div
            className="h-full w-full origin-left bg-white/50"
            initial={{ scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: (TOTAL_MS - 300) / 1000, delay: 0.3, ease: [0.4, 0, 0.2, 1] }}
          />
        </motion.div>
      </div>
    </motion.div>
  );
};

export default SplashScreen;

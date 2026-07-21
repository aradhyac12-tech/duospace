import { useEffect, useState } from "react";
import { motion } from "framer-motion";

interface SplashScreenProps {
  appName?: string;
  onComplete: () => void;
}

/**
 * One-time cinematic boot splash. Mounted once at the app root, on top of
 * the router (which mounts and starts its own data fetches underneath in
 * parallel — this never adds extra wait time, it just controls what's
 * visible for a fixed, intentional duration).
 *
 * Sequence:
 *  1. Logo fades/scales in, centered.
 *  2. Logo rises to the upper third and settles, slightly smaller.
 *  3. App name reveals word-by-word beneath it.
 *  4. Tagline fades in beneath the name.
 *  5. Whole screen fades out -> onComplete() unmounts it.
 *
 * Background is intentionally fixed (not theme-driven) — a splash is brand
 * identity, not a themed surface, and runs before the user's theme choice
 * is guaranteed to have painted.
 */
const SplashScreen = ({ appName = "DuoSpace", onComplete }: SplashScreenProps) => {
  const [phase, setPhase] = useState<"logo" | "rise" | "exit">("logo");

  useEffect(() => {
    const t1 = window.setTimeout(() => setPhase("rise"), 650);
    const t2 = window.setTimeout(() => setPhase("exit"), 2300);
    const t3 = window.setTimeout(() => onComplete(), 2750);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nameWords = appName.split(" ");

  return (
    <motion.div
      className="fixed inset-0 z-[999] flex flex-col items-center justify-center overflow-hidden"
      style={{ background: "radial-gradient(120% 90% at 50% 30%, #17171b 0%, #0a0a0c 60%, #050506 100%)" }}
      initial={{ opacity: 1 }}
      animate={{ opacity: phase === "exit" ? 0 : 1 }}
      transition={{ duration: 0.5, ease: "easeInOut" }}
    >
      {/* Soft ambient glow behind the logo */}
      <motion.div
        className="absolute h-64 w-64 rounded-full bg-white/[0.06] blur-3xl"
        initial={{ opacity: 0, scale: 0.6 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 1.2, ease: "easeOut" }}
        style={{ top: phase === "logo" ? "42%" : "22%", transition: "top 0.9s cubic-bezier(0.22,1,0.36,1)" }}
      />

      <motion.div
        className="flex flex-col items-center"
        initial={{ y: 0 }}
        animate={{ y: phase === "logo" ? 0 : "-18vh" }}
        transition={{ type: "spring", stiffness: 120, damping: 18 }}
      >
        <motion.div
          className="h-20 w-20 rounded-[22px] overflow-hidden shadow-[0_8px_40px_rgba(0,0,0,0.5)]"
          initial={{ opacity: 0, scale: 0.82 }}
          animate={{ opacity: 1, scale: phase === "logo" ? 1 : 0.82 }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
        >
          <img src="/icon-1024.png" alt="" className="h-full w-full object-cover" draggable={false} />
        </motion.div>

        {/* Name — word-by-word cinematic reveal, appears once the logo has settled */}
        <div className="mt-5 flex gap-2 overflow-hidden">
          {nameWords.map((word, i) => (
            <motion.span
              key={word + i}
              className="text-[22px] font-semibold tracking-tight text-white"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: phase !== "logo" ? 1 : 0, y: phase !== "logo" ? 0 : 16 }}
              transition={{ duration: 0.55, delay: 0.15 + i * 0.09, ease: [0.22, 1, 0.36, 1] }}
            >
              {word}
            </motion.span>
          ))}
        </div>

        <motion.p
          className="mt-1.5 text-[12px] tracking-wide text-white/40"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: phase !== "logo" ? 1 : 0, y: phase !== "logo" ? 0 : 10 }}
          transition={{ duration: 0.55, delay: 0.4, ease: [0.22, 1, 0.36, 1] }}
        >
          A space for the two of you
        </motion.p>
      </motion.div>
    </motion.div>
  );
};

export default SplashScreen;

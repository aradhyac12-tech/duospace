/**
 * AuthSuccessAnimation — full-screen success ripple + checkmark draw.
 * Shown briefly after sign-in / sign-up before route transition.
 */
import { motion } from "framer-motion";
import { useEffect } from "react";
import { hapticSuccess } from "@/lib/haptics";

interface Props {
  message?: string;
  onDone?: () => void;
  durationMs?: number;
}

const AuthSuccessAnimation = ({ message = "Welcome back", onDone, durationMs = 1400 }: Props) => {
  useEffect(() => {
    hapticSuccess();
    if (!onDone) return;
    const t = setTimeout(onDone, durationMs);
    return () => clearTimeout(t);
  }, [onDone, durationMs]);

  return (
    <motion.div
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-background/95 backdrop-blur-xl"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <div className="relative">
        {[0, 1, 2].map(i => (
          <motion.div
            key={i}
            className="absolute inset-0 rounded-full border-2 border-primary/40"
            initial={{ scale: 0.6, opacity: 0.6 }}
            animate={{ scale: 2.4, opacity: 0 }}
            transition={{ duration: 1.6, delay: i * 0.25, ease: "easeOut", repeat: Infinity }}
          />
        ))}
        <motion.div
          className="relative h-20 w-20 rounded-full bg-primary flex items-center justify-center shadow-2xl"
          initial={{ scale: 0.5, rotate: -10 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: "spring", stiffness: 260, damping: 18 }}
        >
          <svg viewBox="0 0 24 24" className="h-9 w-9 text-primary-foreground">
            <motion.path
              d="M5 12l4 4 10-10"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 0.5, delay: 0.2, ease: "easeInOut" }}
            />
          </svg>
        </motion.div>
      </div>
      <motion.p
        className="mt-8 text-base font-medium"
        style={{ fontFamily: "var(--font-heading)" }}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.5 }}
      >
        {message}
      </motion.p>
    </motion.div>
  );
};

export default AuthSuccessAnimation;

import { motion, useReducedMotion } from "framer-motion";

// Smooth in/out: the wrapper animates height + opacity so the message list
// glides instead of jumping when the bubble appears/disappears, and the
// bubble itself scales in from its tail corner. Sized to match a real
// one-line partner bubble (px-3 py-2) rather than a chunky pill.
const EASE = [0.32, 0.72, 0, 1] as const;

const TypingIndicator = () => {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1, transition: { height: { duration: 0.22, ease: EASE }, opacity: { duration: 0.18, delay: 0.04 } } }}
      exit={{ height: 0, opacity: 0, transition: { height: { duration: 0.2, ease: EASE, delay: 0.04 }, opacity: { duration: 0.14 } } }}
      style={{ overflow: "hidden" }}
      className="flex justify-start"
      aria-hidden="true"
    >
      <div className="py-0.5">
        <motion.div
          initial={reduce ? false : { scale: 0.6, y: 6 }}
          animate={{ scale: 1, y: 0, transition: { type: "spring", stiffness: 420, damping: 30 } }}
          exit={reduce ? undefined : { scale: 0.85, transition: { duration: 0.12 } }}
          style={{ transformOrigin: "bottom left" }}
          className="bg-[hsl(var(--surface-2))] rounded-2xl rounded-bl-md px-3 py-2"
        >
          <div className="flex items-center gap-[3px] h-3">
            {[0, 1, 2].map((i) => (
              <motion.span
                key={i}
                className="block h-1.5 w-1.5 rounded-full bg-muted-foreground/60"
                animate={reduce ? { opacity: [0.35, 0.9, 0.35] } : { y: [0, -3, 0], opacity: [0.4, 1, 0.4] }}
                transition={{ repeat: Infinity, duration: 1.1, ease: "easeInOut", delay: i * 0.16 }}
              />
            ))}
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
};

export default TypingIndicator;

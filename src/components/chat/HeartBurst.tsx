import { useEffect, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { Heart } from "lucide-react";

/**
 * HeartBurst — a one-shot scatter of small hearts that rise and fade,
 * fired from a parent's `play` prop flipping to true (e.g. the moment a
 * love letter's seal lands, or the moment it's opened for reading).
 *
 * Purely decorative/absolute — render it inside a `position: relative`
 * (or already-absolute) container and it centers itself there. Respects
 * prefers-reduced-motion by rendering nothing at all, same convention as
 * LoveLetter/LetterReader/Envelope already follow for their own motion.
 */
interface HeartBurstProps {
  play: boolean;
  /** CSS color for the hearts — pass the theme's accent hue where one exists. */
  color?: string;
  count?: number;
}

interface Particle {
  id: number;
  x: number;
  size: number;
  delay: number;
  duration: number;
  rotate: number;
  rise: number;
}

let burstSeq = 0;

const HeartBurst = ({ play, color = "hsl(352 78% 58%)", count = 7 }: HeartBurstProps) => {
  const reduceMotion = useReducedMotion();
  const [burstId, setBurstId] = useState<number | null>(null);
  const [particles, setParticles] = useState<Particle[]>([]);

  useEffect(() => {
    if (!play || reduceMotion) return;
    const id = ++burstSeq;
    setBurstId(id);
    setParticles(
      Array.from({ length: count }, (_, i) => ({
        id: i,
        x: (Math.random() - 0.5) * 100,
        size: 9 + Math.random() * 11,
        delay: Math.random() * 0.16,
        duration: 0.85 + Math.random() * 0.5,
        rotate: (Math.random() - 0.5) * 70,
        rise: 54 + Math.random() * 34,
      })),
    );
    // Clears itself well after the longest particle's transition ends, so a
    // re-fire (play flips false -> true again) always starts from empty.
    const t = setTimeout(() => setBurstId((cur) => (cur === id ? null : cur)), 1700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [play]);

  if (reduceMotion) return null;

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "visible" }} aria-hidden="true">
      <AnimatePresence>
        {burstId !== null &&
          particles.map((p) => (
            <motion.div
              key={`${burstId}-${p.id}`}
              initial={{ opacity: 0, x: 0, y: 0, scale: 0.4, rotate: 0 }}
              animate={{ opacity: [0, 1, 1, 0], x: p.x, y: -p.rise, scale: 1, rotate: p.rotate }}
              exit={{ opacity: 0 }}
              transition={{ duration: p.duration, delay: p.delay, ease: [0.22, 1, 0.36, 1] }}
              style={{ position: "absolute", left: "50%", top: "50%", marginLeft: -p.size / 2, marginTop: -p.size / 2 }}
            >
              <Heart style={{ width: p.size, height: p.size, color }} fill="currentColor" />
            </motion.div>
          ))}
      </AnimatePresence>
    </div>
  );
};

export default HeartBurst;

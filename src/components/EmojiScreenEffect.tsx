import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";

interface FloatingEmoji {
  id: number;
  emoji: string;
  x: number;
  delay: number;
  size: number;
}

const TRIGGER_EMOJIS: Record<string, string> = {
  "❤️": "❤️",
  "♥️": "❤️",
  "💕": "💕",
  "💖": "💖",
  "💗": "💗",
  "😍": "😍",
  "🥰": "🥰",
  "💘": "💘",
  "💝": "💝",
  "🔥": "🔥",
  "🎉": "🎉",
  "⭐": "⭐",
  "🌟": "🌟",
};

let globalId = 0;

const EmojiScreenEffect = () => {
  const [effects, setEffects] = useState<FloatingEmoji[]>([]);

  const triggerEffect = useCallback((emoji: string) => {
    const newEmojis: FloatingEmoji[] = Array.from({ length: 25 }, () => ({
      id: globalId++,
      emoji,
      x: Math.random() * 100,
      delay: Math.random() * 0.8,
      size: 16 + Math.random() * 24,
    }));
    setEffects(prev => [...prev, ...newEmojis]);
    setTimeout(() => {
      setEffects(prev => prev.filter(e => !newEmojis.includes(e)));
    }, 3500);
  }, []);

  useEffect(() => {
    const handler = (e: CustomEvent<{ emoji: string }>) => {
      const mapped = TRIGGER_EMOJIS[e.detail.emoji];
      if (mapped) triggerEffect(mapped);
    };
    window.addEventListener("emoji-effect" as any, handler);
    return () => window.removeEventListener("emoji-effect" as any, handler);
  }, [triggerEffect]);

  if (effects.length === 0) return null;

  return (
    <div className="fixed inset-0 pointer-events-none z-[60] overflow-hidden">
      <AnimatePresence>
        {effects.map((e) => (
          <motion.div
            key={e.id}
            initial={{ y: "110vh", opacity: 1, scale: 0.5 }}
            animate={{ y: "-10vh", opacity: [1, 1, 0], scale: [0.5, 1.2, 0.8] }}
            exit={{ opacity: 0 }}
            transition={{
              duration: 2.5 + Math.random(),
              delay: e.delay,
              ease: "easeOut",
            }}
            style={{
              position: "absolute",
              left: `${e.x}%`,
              fontSize: `${e.size}px`,
            }}
          >
            {e.emoji}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
};

export default EmojiScreenEffect;

export const dispatchEmojiEffect = (emoji: string) => {
  window.dispatchEvent(new CustomEvent("emoji-effect", { detail: { emoji } }));
};

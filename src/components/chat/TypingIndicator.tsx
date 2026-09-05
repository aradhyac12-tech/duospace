import { motion } from "framer-motion";

const TypingIndicator = () => (
  <motion.div
    initial={{ opacity: 0, y: 10 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: 10 }}
    className="flex justify-start"
  >
    {/* MICRO-DETAIL: was bg-card + shadow-sm + border-border — the old
        "bordered card" bubble treatment Phase 2 deliberately moved away
        from for every other bubble (see MessageBubble.tsx's partner-tone
        comment: "don't put every message in a card," "don't add shadows
        to every message"). This indicator got missed in that pass, so it
        was the one bubble in the whole thread still reading as an older,
        heavier visual language. Now matches the exact partner-bubble
        surface/corner treatment. */}
    <div className="bg-[hsl(var(--surface-2))] rounded-2xl rounded-bl-md px-4 py-3">
      <div className="flex items-center gap-1">
        {[0, 1, 2].map((i) => (
          <motion.div
            key={i}
            className="h-2 w-2 rounded-full bg-muted-foreground/50"
            animate={{ y: [0, -4, 0] }}
            transition={{ repeat: Infinity, duration: 0.6, delay: i * 0.15 }}
          />
        ))}
      </div>
    </div>
  </motion.div>
);

export default TypingIndicator;

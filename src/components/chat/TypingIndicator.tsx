import { motion } from "framer-motion";

const TypingIndicator = () => (
  <motion.div
    initial={{ opacity: 0, y: 10 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: 10 }}
    className="flex justify-start"
  >
    <div className="bg-card rounded-2xl rounded-bl-md shadow-sm border border-border px-4 py-3">
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

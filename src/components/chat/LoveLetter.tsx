import { useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { Feather, X, Send, Heart } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { hapticSelection, hapticSend, hapticSuccess } from "@/lib/haptics";
import Envelope from "@/components/chat/Envelope";
import HeartBurst from "@/components/chat/HeartBurst";

interface LoveLetterProps {
  onSend: (subject: string, body: string) => void;
  onClose: () => void;
  partnerName: string;
}

const LETTER_THEMES = [
  { id: "warm", label: "Warm", bg: "bg-[hsl(30,40%,96%)]", border: "border-[hsl(28,30%,82%)]", accent: "text-[hsl(28,40%,50%)]", line: "bg-[hsl(28,30%,82%)]" },
  { id: "rose", label: "Rosé", bg: "bg-[hsl(350,35%,96%)]", border: "border-[hsl(350,35%,82%)]", accent: "text-[hsl(350,50%,55%)]", line: "bg-[hsl(350,35%,82%)]" },
  { id: "ocean", label: "Ocean", bg: "bg-[hsl(195,35%,95%)]", border: "border-[hsl(195,35%,80%)]", accent: "text-[hsl(195,55%,45%)]", line: "bg-[hsl(195,35%,80%)]" },
  { id: "midnight", label: "Night", bg: "bg-[hsl(230,20%,14%)]", border: "border-[hsl(230,15%,25%)]", accent: "text-[hsl(220,50%,65%)]", line: "bg-[hsl(230,15%,25%)]" },
];

// Content reveal: sections stagger in one beat after another once the
// letter card has landed, so composing feels like unfolding a letter
// rather than a form appearing all at once.
const contentVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06, delayChildren: 0.1 } },
};
const sectionVariants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: 0.32, ease: [0.22, 1, 0.36, 1] } },
};

// Timings for the fold-and-seal sequence played on Send, before onSend
// actually fires — mirrors LetterReader's open sequence run in reverse
// (letter drops into the pocket, then the flap swings shut and the seal
// lands), so sending a letter feels like the same physical object as
// receiving one.
const DRAW_MS = 420;
const FLAP_MS = 460;

const LoveLetter = ({ onSend, onClose, partnerName }: LoveLetterProps) => {
  const reduceMotion = useReducedMotion();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [theme, setTheme] = useState(LETTER_THEMES[0]);
  const [sealing, setSealing] = useState(false);
  const [sealPhase, setSealPhase] = useState<"drawing" | "flap">("drawing");

  const handleSend = () => {
    if (!body.trim() || sealing) return;
    hapticSend();
    if (reduceMotion) {
      onSend(subject || "A letter for you 💌", body.trim());
      return;
    }
    setSealing(true);
    setSealPhase("drawing");
    setTimeout(() => {
      // The beat where the flap actually swings shut over the seal —
      // pair it with a success tap so "sealed" reads as tactile, not
      // just visual, the same way hapticSend/hapticSuccess pair up on
      // every other send affordance in the app (MessageComposer,
      // CameraWithFilters).
      setSealPhase("flap");
      hapticSuccess();
    }, DRAW_MS);
    setTimeout(() => onSend(subject || "A letter for you 💌", body.trim()), DRAW_MS + FLAP_MS);
  };

  const wordCount = body.trim().split(/\s+/).filter(Boolean).length;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.22, ease: "easeOut" }}
      className="fixed inset-0 z-50 flex items-end justify-center p-4 bg-black/40 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget && !sealing) onClose(); }}
    >
      {/* Card animates independently of the backdrop — a spring pop-and-
          settle so the letter feels like it's dropped into place, rather
          than the whole dimmed screen scaling with it. */}
      <motion.div
        initial={{ opacity: 0, y: 52, scale: 0.94 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 28, scale: 0.96, transition: { duration: 0.18, ease: "easeIn" } }}
        transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 340, damping: 30, mass: 0.9 }}
        className={`w-full max-w-lg rounded-3xl border-2 shadow-2xl overflow-hidden ${theme.bg} ${theme.border}`}
      >
        <AnimatePresence mode="wait">
          {sealing ? (
            // Fold-and-seal: the letter card is replaced by the same
            // Envelope used to open received letters, animating shut —
            // the visible confirmation that this letter is now "sealed
            // and sent" before the composer dismisses itself.
            <motion.div
              key="sealing"
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              className="flex flex-col items-center justify-center gap-4 py-16"
            >
              <div className="relative">
                <Envelope
                  width={190}
                  flapOpen={sealPhase === "drawing"}
                  letterLift={sealPhase === "drawing" ? 1 : 0}
                  showSeal={sealPhase === "flap"}
                  letterTitle={subject || "A letter for you 💌"}
                />
                {/* Fires the instant the flap lands and the seal appears —
                    the visual payoff that goes with the hapticSuccess()
                    tap fired at the same moment in handleSend. */}
                <HeartBurst play={sealPhase === "flap"} />
              </div>
              <motion.span
                key={sealPhase}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 0.7, y: 0 }}
                transition={{ duration: 0.25 }}
                className={`text-xs font-medium ${theme.accent}`}
              >
                {sealPhase === "drawing" ? "Sealing your letter…" : "Sent with love 💌"}
              </motion.span>
            </motion.div>
          ) : (
            <motion.div
              key="writing"
              variants={contentVariants}
              initial="hidden"
              animate="show"
              exit={{ opacity: 0, transition: { duration: 0.15 } }}
              className="px-5 py-5 space-y-4"
            >
              {/* Header */}
              <motion.div variants={sectionVariants} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Feather className={`h-4 w-4 ${theme.accent}`} />
                  <span className={`text-sm font-medium ${theme.accent}`}>Love Letter</span>
                </div>
                <div className="flex items-center gap-3">
                  {/* Theme picker */}
                  <div className="flex gap-1.5">
                    {LETTER_THEMES.map((t) => (
                      <motion.button
                        key={t.id}
                        type="button"
                        aria-label={`${t.label} theme`}
                        onClick={() => { hapticSelection(); setTheme(t); }}
                        whileTap={{ scale: 0.85 }}
                        animate={{ scale: theme.id === t.id ? 1.2 : 1 }}
                        transition={{ type: "spring", stiffness: 500, damping: 24 }}
                        className={`h-5 w-5 rounded-full border-2 ${t.bg} ${theme.id === t.id ? t.border : "border-transparent"}`}
                      />
                    ))}
                  </div>
                  <button onClick={() => { onClose(); }} className="h-7 w-7 flex items-center justify-center opacity-40 hover:opacity-70 transition-opacity">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </motion.div>

              {/* To */}
              <motion.div variants={sectionVariants}>
                <p className="text-xs opacity-50 mb-1">To</p>
                <p className={`text-base font-serif ${theme.accent}`}>
                  My dearest {partnerName} ♥
                </p>
              </motion.div>

              {/* Subject */}
              <motion.div variants={sectionVariants}>
                <Input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Subject (optional)..."
                  className={`border-0 border-b rounded-none px-0 bg-transparent text-sm font-medium placeholder:opacity-40 focus-visible:ring-0 ${theme.accent}`}
                />
              </motion.div>

              {/* Body */}
              <motion.div variants={sectionVariants}>
                <Textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder={`Write from your heart…\n\nEvery word you write will be delivered as a beautiful letter that ${partnerName} can keep forever.`}
                  className={`border-0 rounded-none px-0 bg-transparent resize-none min-h-[180px] text-sm leading-relaxed placeholder:opacity-30 focus-visible:ring-0 break-words`}
                  style={{ fontFamily: "Georgia, 'Times New Roman', serif", overflowWrap: "anywhere" }}
                />
              </motion.div>

              {/* Footer */}
              <motion.div variants={sectionVariants} className="flex items-center justify-between pt-1">
                <div className="flex items-center gap-2">
                  <p className="text-[11px] opacity-40">{wordCount} {wordCount === 1 ? "word" : "words"}</p>
                  <AnimatePresence>
                    {wordCount > 10 && (
                      <motion.span
                        initial={{ opacity: 0, scale: 0.6 }}
                        animate={{ opacity: 0.6, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.6 }}
                        transition={{ type: "spring", stiffness: 400, damping: 20 }}
                      >
                        <Heart className={`h-3 w-3 ${theme.accent}`} />
                      </motion.span>
                    )}
                  </AnimatePresence>
                </div>
                <Button
                  onClick={handleSend}
                  disabled={!body.trim()}
                  className={`rounded-xl gap-2 ${theme.id === "midnight" ? "bg-white text-gray-900 hover:bg-white/90" : "bg-primary text-primary-foreground"}`}
                >
                  <Send className="h-3.5 w-3.5" />
                  <span className="text-sm">Send Letter</span>
                </Button>
              </motion.div>

              {/* Decorative bottom line */}
              <motion.div variants={sectionVariants} className={`-mx-5 -mb-5 h-1 w-[calc(100%+2.5rem)] ${theme.line} opacity-20`} />
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
};

export default LoveLetter;

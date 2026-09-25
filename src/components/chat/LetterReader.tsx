import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { X, Heart } from "lucide-react";
import Envelope from "@/components/chat/Envelope";
import HeartBurst from "@/components/chat/HeartBurst";
import { parseLetterContent } from "@/lib/letter";
import { hapticLight, hapticSelection } from "@/lib/haptics";

interface LetterReaderProps {
  content: string;
  senderName: string;
  isMine: boolean;
  timeLabel?: string;
  onClose: () => void;
}

/**
 * Full-screen envelope-opening/closing sequence for reading a delivered
 * love letter. A tap on the letter bubble in MessageBubble opens this; it
 * never re-encodes or persists anything — `content` is the same decrypted
 * string the bubble already has, parsed with the shared lib/letter helpers
 * so the reader always matches what was actually sent.
 *
 * Phase machine (mirrors a real envelope):
 *   closed → opening (flap lifts, seal breaks) → drawing (letter slides
 *   clear of the pocket) → reading (envelope fades back, full letter shown)
 *   — and the reverse on close, ending in onClose() only once the envelope
 *   has visually resealed.
 */
type Phase = "closed" | "opening" | "drawing" | "reading" | "closing-draw" | "closing-flap";

const FLAP_MS = 480;
const DRAW_MS = 460;

// The read-out unfolds line by line rather than appearing all at once —
// title first, then each paragraph a beat behind the last.
const pageVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05, delayChildren: 0.08 } },
};
const lineVariants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { duration: 0.26, ease: [0.22, 1, 0.36, 1] } },
};

const LetterReader = ({ content, senderName, isMine, timeLabel, onClose }: LetterReaderProps) => {
  const reduceMotion = useReducedMotion();
  const { subject, body } = useMemo(() => parseLetterContent(content), [content]);
  const [phase, setPhase] = useState<Phase>(reduceMotion ? "reading" : "closed");

  useEffect(() => {
    if (reduceMotion) return;
    // Light tap as the seal visually cracks (flap starts lifting) and a
    // slightly firmer one once the page has actually settled into view —
    // the same "small tick, then a settled confirmation" pairing
    // LoveLetter's own seal-and-send sequence uses, so opening a letter
    // feels like the tactile counterpart of sending one.
    const t0 = setTimeout(() => { setPhase("opening"); hapticLight(); }, 90);
    const t1 = setTimeout(() => setPhase("drawing"), 90 + FLAP_MS * 0.55);
    const t2 = setTimeout(() => { setPhase("reading"); hapticSelection(); }, 90 + FLAP_MS * 0.55 + DRAW_MS);
    return () => { clearTimeout(t0); clearTimeout(t1); clearTimeout(t2); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const requestClose = () => {
    if (reduceMotion) { onClose(); return; }
    setPhase("closing-draw");
    setTimeout(() => setPhase("closing-flap"), DRAW_MS);
    setTimeout(onClose, DRAW_MS + FLAP_MS);
  };

  const flapOpen = phase === "opening" || phase === "drawing" || phase === "reading" || phase === "closing-draw";
  const lift = phase === "drawing" || phase === "reading" ? 1 : phase === "closing-draw" ? 0 : 0;
  const showSeal = phase === "closed" || phase === "closing-flap";
  const showEnvelope = phase !== "reading";

  return (
    <motion.div
      className="fixed inset-0 z-[60] flex items-center justify-center p-6 bg-black/55 backdrop-blur-md"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onClick={(e) => { if (e.target === e.currentTarget) requestClose(); }}
    >
      <motion.button
        onClick={requestClose}
        aria-label="Close letter"
        whileTap={{ scale: 0.9 }}
        className="absolute top-5 right-5 h-9 w-9 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white/80 hover:text-white transition-colors backdrop-blur-sm border border-white/10"
      >
        <X className="h-4.5 w-4.5" />
      </motion.button>

      {/* Bursts from screen-center right as the envelope hands off to the
          reading card (phase -> "reading") — sits above both AnimatePresence
          children rather than inside either one, so it isn't tied to
          whichever of them happens to be mounted at that instant. */}
      <HeartBurst play={phase === "reading"} />

      <AnimatePresence mode="wait">
        {showEnvelope ? (
          <motion.div
            key="envelope"
            initial={{ opacity: 0, scale: 0.85, y: 16, rotate: -2 }}
            animate={{ opacity: 1, scale: 1, y: 0, rotate: 0 }}
            exit={{ opacity: 0, scale: 0.92 }}
            transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 300, damping: 26 }}
          >
            <Envelope
              width={260}
              flapOpen={flapOpen}
              letterLift={lift}
              showSeal={showSeal}
              letterTitle={subject}
              instant={!!reduceMotion}
            />
          </motion.div>
        ) : (
          <motion.div
            key="reading"
            initial={{ opacity: 0, scale: 0.94, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -6 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
            className="w-full max-w-md max-h-[80vh] rounded-2xl overflow-x-hidden overflow-y-hidden flex flex-col shadow-2xl"
            style={{ background: "hsl(38 48% 97%)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 pt-6 pb-3 flex items-center gap-2 shrink-0" style={{ color: "hsl(20 18% 30%)" }}>
              <Heart className="h-4 w-4 opacity-60" fill="currentColor" />
              <span className="text-xs font-medium opacity-60">
                {isMine ? "You wrote" : `${senderName} wrote`}{timeLabel ? ` · ${timeLabel}` : ""}
              </span>
            </div>
            <motion.div
              variants={reduceMotion ? undefined : pageVariants}
              initial={reduceMotion ? undefined : "hidden"}
              animate={reduceMotion ? undefined : "show"}
              className="px-6 pb-6 overflow-y-auto overflow-x-hidden"
              style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
            >
              <motion.h2
                variants={reduceMotion ? undefined : lineVariants}
                className="text-lg font-semibold mb-3 break-words"
                style={{ color: "hsl(20 18% 30%)", overflowWrap: "anywhere" }}
              >
                {subject}
              </motion.h2>
              {body.split("\n").map((line, i) => (
                <motion.p
                  key={i}
                  variants={reduceMotion ? undefined : lineVariants}
                  className="text-[15px] leading-relaxed mb-2 last:mb-0 break-words whitespace-pre-wrap"
                  style={{ color: "hsl(20 18% 30%)", overflowWrap: "anywhere" }}
                >
                  {line || "\u00A0"}
                </motion.p>
              ))}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};

export default LetterReader;

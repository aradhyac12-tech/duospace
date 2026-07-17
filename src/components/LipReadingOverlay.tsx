// LipReadingOverlay — fixed:
// LR-01: Label clarified ("Partner's lips")
// LR-07: Auto-scroll transcript using useEffect on lines/currentWord change
import { motion, AnimatePresence } from "framer-motion";
import { X, Copy, Trash2, Captions, AlertCircle, ChevronDown } from "lucide-react";
import { useState, useCallback, useRef, useEffect } from "react";
import { useLipReading, LipReadLanguage, LipReadResult } from "@/hooks/useLipReading";
import { useToast } from "@/hooks/use-toast";

interface LipReadingOverlayProps {
  videoRef: React.RefObject<HTMLVideoElement>;
  onClose: () => void;
}

const LANGUAGES: Array<{ code: LipReadLanguage; native: string; flag: string }> = [
  { code: "en", native: "English", flag: "🇬🇧" },
  { code: "hi", native: "हिंदी",    flag: "🇮🇳" },
  { code: "mr", native: "मराठी",   flag: "🇮🇳" },
];

const LipReadingOverlay = ({ videoRef, onClose }: LipReadingOverlayProps) => {
  const { toast } = useToast();
  const [language,     setLanguage]     = useState<LipReadLanguage>("en");
  const [lines,        setLines]        = useState<string[]>([]);
  const [currentWord,  setCurrentWord]  = useState("");
  const [confidence,   setConfidence]   = useState(0);
  const [collapsed,    setCollapsed]    = useState(false);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  const handleResult = useCallback((result: LipReadResult) => {
    setConfidence(result.confidence);
    if (result.isFinal || result.transcript.length > 12) {
      setLines(prev => {
        const combined = [...prev, result.transcript].join(" ");
        const words    = combined.split(" ").slice(-40);
        return [words.join(" ")];
      });
      setCurrentWord("");
    } else {
      setCurrentWord(result.transcript);
    }
  }, []);

  const { isActive, isLoading, error, start, stop, clearTranscript } = useLipReading({
    language,
    onResult: handleResult,
    videoRef,
  });

  // LR-07 FIX: auto-scroll to bottom when transcript updates.
  // transcriptEndRef was declared and attached but scrollIntoView() was never called.
  useEffect(() => {
    if (transcriptEndRef.current && !collapsed) {
      transcriptEndRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [lines, currentWord, collapsed]);

  const toggleActive = () => {
    if (isActive) stop();
    else start();
  };

  const handleClear = () => {
    clearTranscript();
    setLines([]);
    setCurrentWord("");
  };

  const handleCopy = () => {
    const text = [lines.join(" "), currentWord].filter(Boolean).join(" ").trim();
    if (text) { navigator.clipboard.writeText(text); toast({ title: "Copied" }); }
  };

  const handleLangChange = (lang: LipReadLanguage) => {
    setLanguage(lang);
    setLines([]);
    setCurrentWord("");
  };

  const hasText = lines.length > 0 || currentWord;

  return (
    <motion.div
      initial={{ y: 50, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: 50, opacity: 0 }}
      transition={{ type: "spring", stiffness: 420, damping: 38 }}
      className="absolute bottom-28 left-3 right-3 z-30 rounded-2xl overflow-hidden border border-white/10"
      style={{ background: "rgba(0,0,0,0.82)", backdropFilter: "blur(20px)" }}
      onClick={e => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <div className={`h-2 w-2 rounded-full shrink-0 ${isActive ? "bg-green-400 animate-pulse" : "bg-white/20"}`} />
        <Captions className="h-3.5 w-3.5 text-white/50 shrink-0" />
        {/* LR-01 FIX: clarify this reads the partner's lips, not the user's */}
        <span className="text-[11px] text-white/60 flex-1 min-w-0 truncate">
          {isLoading ? "Loading model…" : isActive ? "Reading partner's lips" : "Partner Lip Reading"}
        </span>
        <div className="flex items-center gap-1">
          {hasText && (
            <>
              <button onClick={handleCopy}
                className="h-7 w-7 rounded-full bg-white/10 flex items-center justify-center active:bg-white/20">
                <Copy className="h-3 w-3 text-white/60" />
              </button>
              <button onClick={handleClear}
                className="h-7 w-7 rounded-full bg-white/10 flex items-center justify-center active:bg-white/20">
                <Trash2 className="h-3 w-3 text-white/60" />
              </button>
            </>
          )}
          <button onClick={() => setCollapsed(v => !v)}
            className="h-7 w-7 rounded-full bg-white/10 flex items-center justify-center">
            <motion.div animate={{ rotate: collapsed ? 180 : 0 }} transition={{ duration: 0.2 }}>
              <ChevronDown className="h-3.5 w-3.5 text-white/60" />
            </motion.div>
          </button>
          <button onClick={onClose}
            className="h-7 w-7 rounded-full bg-white/10 flex items-center justify-center active:bg-white/20">
            <X className="h-3.5 w-3.5 text-white/60" />
          </button>
        </div>
      </div>

      <AnimatePresence>
        {!collapsed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            {/* Language tabs */}
            <div className="px-4 pb-2.5 flex gap-1.5">
              {LANGUAGES.map(lang => (
                <button key={lang.code} onClick={() => handleLangChange(lang.code)}
                  className={`px-3 py-1 rounded-full text-[11px] font-medium transition-all ${
                    language === lang.code ? "bg-white text-black scale-105" : "bg-white/10 text-white/50 hover:bg-white/15"
                  }`}>
                  {lang.flag} {lang.native}
                </button>
              ))}
            </div>

            {/* Transcript — LR-07: scrollable container with ref at bottom */}
            <div className="px-4 min-h-[56px] max-h-[100px] overflow-y-auto pb-1">
              {error ? (
                <div className="flex items-start gap-2 text-red-400 py-1">
                  <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <p className="text-[11px] leading-relaxed">{error}</p>
                </div>
              ) : !hasText ? (
                <p className="text-[11px] text-white/25 italic py-1">
                  {language === "hi" ? "बात करें…" : language === "mr" ? "बोला…" : "Waiting for partner to speak…"}
                </p>
              ) : (
                <p className="text-sm text-white leading-relaxed font-medium py-1">
                  {lines.join(" ")}
                  {currentWord && (
                    <span className={`ml-1 transition-opacity ${confidence > 0.55 ? "opacity-100" : "opacity-40"}`}>
                      {currentWord}
                    </span>
                  )}
                  {isActive && <span className="ml-0.5 text-white/30 animate-pulse">▊</span>}
                </p>
              )}
              {/* LR-07: anchor for auto-scroll */}
              <div ref={transcriptEndRef} />
            </div>

            {/* Confidence bar */}
            {isActive && (
              <div className="px-4 pb-2">
                <div className="h-0.5 bg-white/10 rounded-full overflow-hidden">
                  <motion.div
                    className={`h-full rounded-full ${confidence > 0.6 ? "bg-green-400" : confidence > 0.4 ? "bg-yellow-400" : "bg-red-400"}`}
                    animate={{ width: `${Math.round(confidence * 100)}%` }}
                    transition={{ duration: 0.15 }}
                  />
                </div>
                <p className="text-[9px] text-white/25 mt-0.5 text-right">{Math.round(confidence * 100)}% confidence</p>
              </div>
            )}

            {/* Start/Stop button */}
            <div className="px-4 pb-3">
              <button onClick={toggleActive} disabled={isLoading}
                className={`w-full py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-40 ${
                  isActive ? "bg-red-500/80 text-white" : "bg-white text-black"
                }`}>
                {isLoading ? "Loading MediaPipe…" : isActive ? "Stop" : "Start Lip Reading"}
              </button>
            </div>

            <div className="px-4 pb-3">
              <p className="text-[9px] text-white/20 leading-tight">
                Reads your <strong className="text-white/30">partner's</strong> lips via their video feed.
                ~40–60% accuracy. Bilabial sounds (p/b/m / प/ब/म) are visually identical.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};

export default LipReadingOverlay;

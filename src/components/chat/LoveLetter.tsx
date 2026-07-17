import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Feather, X, Send, Heart } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface LoveLetterProps {
  onSend: (subject: string, body: string) => void;
  onClose: () => void;
  partnerName: string;
}

const LETTER_THEMES = [
  { id: "warm", label: "Warm", bg: "bg-[hsl(30,40%,96%)]", border: "border-[hsl(28,30%,82%)]", accent: "text-[hsl(28,40%,50%)]" },
  { id: "rose", label: "Rosé", bg: "bg-[hsl(350,35%,96%)]", border: "border-[hsl(350,35%,82%)]", accent: "text-[hsl(350,50%,55%)]" },
  { id: "ocean", label: "Ocean", bg: "bg-[hsl(195,35%,95%)]", border: "border-[hsl(195,35%,80%)]", accent: "text-[hsl(195,55%,45%)]" },
  { id: "midnight", label: "Night", bg: "bg-[hsl(230,20%,14%)]", border: "border-[hsl(230,15%,25%)]", accent: "text-[hsl(220,50%,65%)]" },
];

const LoveLetter = ({ onSend, onClose, partnerName }: LoveLetterProps) => {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [theme, setTheme] = useState(LETTER_THEMES[0]);
  const [sending, setSending] = useState(false);

  const handleSend = async () => {
    if (!body.trim()) return;
    setSending(true);
    await onSend(subject || "A letter for you 💌", body.trim());
    setSending(false);
  };

  const wordCount = body.trim().split(/\s+/).filter(Boolean).length;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95, y: 20 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95, y: 20 }}
      className="fixed inset-0 z-50 flex items-end justify-center p-4 bg-black/40 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        initial={{ y: 40 }}
        animate={{ y: 0 }}
        className={`w-full max-w-lg rounded-3xl border-2 shadow-2xl overflow-hidden ${theme.bg} ${theme.border}`}
      >
        {/* Header */}
        <div className={`flex items-center justify-between px-5 pt-5 pb-3`}>
          <div className="flex items-center gap-2">
            <Feather className={`h-4 w-4 ${theme.accent}`} />
            <span className={`text-sm font-medium ${theme.accent}`}>Love Letter</span>
          </div>
          <div className="flex items-center gap-2">
            {/* Theme picker */}
            <div className="flex gap-1">
              {LETTER_THEMES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTheme(t)}
                  className={`h-5 w-5 rounded-full border-2 transition-transform ${t.bg} ${theme.id === t.id ? `${t.border} scale-125` : "border-transparent"}`}
                />
              ))}
            </div>
            <button onClick={onClose} className="h-7 w-7 flex items-center justify-center opacity-40 hover:opacity-70">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* To */}
        <div className="px-5 pb-2">
          <p className={`text-xs opacity-50 mb-1`}>To</p>
          <p className={`text-base font-serif ${theme.accent}`}>
            My dearest {partnerName} ♥
          </p>
        </div>

        {/* Subject */}
        <div className="px-5 pb-3">
          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject (optional)..."
            className={`border-0 border-b rounded-none px-0 bg-transparent text-sm font-medium placeholder:opacity-40 focus-visible:ring-0 ${theme.accent}`}
          />
        </div>

        {/* Body */}
        <div className="px-5 pb-3">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={`Write from your heart…\n\nEvery word you write will be delivered as a beautiful letter that ${partnerName} can keep forever.`}
            className={`border-0 rounded-none px-0 bg-transparent resize-none min-h-[180px] text-sm leading-relaxed placeholder:opacity-30 focus-visible:ring-0`}
            style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
          />
        </div>

        {/* Footer */}
        <div className="px-5 pb-5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <p className={`text-[11px] opacity-40`}>{wordCount} {wordCount === 1 ? "word" : "words"}</p>
            {wordCount > 10 && <Heart className={`h-3 w-3 ${theme.accent} opacity-60`} />}
          </div>
          <Button
            onClick={handleSend}
            disabled={!body.trim() || sending}
            className={`rounded-xl gap-2 ${theme.id === "midnight" ? "bg-white text-gray-900 hover:bg-white/90" : "bg-foreground text-background"}`}
          >
            {sending ? (
              <span className="text-sm">Sending…</span>
            ) : (
              <>
                <Send className="h-3.5 w-3.5" />
                <span className="text-sm">Send Letter</span>
              </>
            )}
          </Button>
        </div>

        {/* Decorative bottom line */}
        <div className={`h-1 w-full ${theme.border.replace("border-", "bg-").replace("[hsl", "").split("]")[0].trim() || "bg-border"} opacity-20`} />
      </motion.div>
    </motion.div>
  );
};

export default LoveLetter;

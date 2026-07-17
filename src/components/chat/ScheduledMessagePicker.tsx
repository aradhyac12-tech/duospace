import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Clock, X, Send, Calendar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface ScheduledMessagePickerProps {
  message: string;
  onSchedule: (sendAt: Date) => void;
  onClose: () => void;
}

const QUICK_OPTIONS = [
  { label: "In 1 hour", mins: 60 },
  { label: "Tonight 8 PM", getDate: () => { const d = new Date(); d.setHours(20, 0, 0, 0); if (d <= new Date()) d.setDate(d.getDate() + 1); return d; } },
  { label: "Tomorrow 9 AM", getDate: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d; } },
  { label: "Next morning", getDate: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); return d; } },
];

const ScheduledMessagePicker = ({ message, onSchedule, onClose }: ScheduledMessagePickerProps) => {
  const [customDateTime, setCustomDateTime] = useState("");

  const handleQuick = (option: typeof QUICK_OPTIONS[0]) => {
    const date = option.getDate ? option.getDate() : new Date(Date.now() + option.mins! * 60000);
    onSchedule(date);
  };

  const handleCustom = () => {
    if (!customDateTime) return;
    const date = new Date(customDateTime);
    if (isNaN(date.getTime()) || date <= new Date()) return;
    onSchedule(date);
  };

  // Min datetime = now + 1 min
  const minDt = new Date(Date.now() + 60000).toISOString().slice(0, 16);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
      className="absolute bottom-full left-0 right-0 mb-2 mx-3 bg-card border border-border rounded-2xl shadow-xl p-4 z-20"
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-muted-foreground" />
          <p className="text-sm font-medium">Schedule message</p>
        </div>
        <button onClick={onClose} className="h-6 w-6 flex items-center justify-center text-muted-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Preview */}
      <div className="bg-muted/40 rounded-xl p-2.5 mb-3">
        <p className="text-xs text-muted-foreground truncate">"{message}"</p>
      </div>

      {/* Quick options */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        {QUICK_OPTIONS.map((opt) => (
          <button
            key={opt.label}
            onClick={() => handleQuick(opt)}
            className="text-xs bg-muted/50 hover:bg-accent rounded-xl px-3 py-2.5 text-left transition-colors active:scale-95"
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Custom datetime */}
      <div className="flex gap-2">
        <Input
          type="datetime-local"
          value={customDateTime}
          min={minDt}
          onChange={(e) => setCustomDateTime(e.target.value)}
          className="flex-1 h-9 rounded-xl text-xs"
        />
        <Button
          onClick={handleCustom}
          disabled={!customDateTime}
          size="sm"
          className="h-9 rounded-xl bg-foreground text-background px-3"
        >
          <Send className="h-3.5 w-3.5" />
        </Button>
      </div>
    </motion.div>
  );
};

export default ScheduledMessagePicker;

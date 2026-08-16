import { PhoneIncoming, PhoneOutgoing, PhoneMissed, Trash2 } from "lucide-react";
import { motion, useMotionValue, useTransform, animate } from "framer-motion";
import { useRef } from "react";
import { hapticMedium, hapticWarning } from "@/lib/haptics";
import type { CallRecord } from "@/pages/Calls";

// ─── CallHistoryRow ───────────────────────────────────────────────────────────
// Extracted unchanged from pages/Calls.tsx (DA-02, first step of the same
// state-stays-in-the-page / UI-gets-extracted decomposition already used on
// Chat.tsx). This was already a self-contained, purely presentational
// component defined inline in that file — no logic changed here, only its
// location. callIcons/formatCallTime/formatDurationShort/SWIPE_DELETE_PX
// moved with it since (confirmed via grep before moving) nothing else in
// Calls.tsx used them.
//
// Delete used to be a hover-only icon (opacity-0 group-hover) — invisible and
// unreachable on touch devices since there's no hover state. Swipe-left now
// reveals a delete action (iOS Mail / WhatsApp convention); the icon is also
// kept at low resting opacity so touch users can still discover + tap it
// directly without needing to swipe first.

const callIcons = {
  outgoing: PhoneOutgoing,
  incoming: PhoneIncoming,
  missed: PhoneMissed,
};

const formatDurationShort = (seconds: number) => {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
};

const formatCallTime = (iso: string) => {
  const d = new Date(iso);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (isToday) return `Today, ${time}`;
  if (isYesterday) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
};

const SWIPE_DELETE_PX = 76;

const CallHistoryRow = ({
  call, index, isMissed, direction, onDelete,
}: {
  call: CallRecord; index: number; isMissed: boolean; direction: "outgoing" | "incoming";
  onDelete: (id: string) => void;
}) => {
  const type = isMissed ? "missed" : direction;
  const Icon = callIcons[type as keyof typeof callIcons] || PhoneOutgoing;
  const x = useMotionValue(0);
  const deleteOpacity = useTransform(x, [-SWIPE_DELETE_PX, -SWIPE_DELETE_PX * 0.4, 0], [1, 0.4, 0]);
  const armedRef = useRef(false);

  const commitDelete = () => {
    hapticWarning();
    animate(x, -400, { duration: 0.18, ease: "easeIn", onComplete: () => onDelete(call.id) });
  };

  return (
    <div className="relative overflow-hidden rounded-xl">
      <motion.div
        aria-hidden="true"
        style={{ opacity: deleteOpacity }}
        className="absolute inset-y-0 right-0 w-20 flex items-center justify-center bg-destructive"
      >
        <Trash2 className="h-4 w-4 text-destructive-foreground" />
      </motion.div>
      <motion.div
        initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}
        transition={{ delay: index * 0.05 }}
        style={{ x, touchAction: "pan-y" }}
        drag="x"
        dragDirectionLock
        dragConstraints={{ left: -SWIPE_DELETE_PX, right: 0 }}
        dragElastic={{ left: 0.15, right: 0 }}
        onDrag={(_, info) => {
          const past = info.offset.x <= -SWIPE_DELETE_PX;
          if (past && !armedRef.current) { armedRef.current = true; hapticMedium(); }
          else if (!past && armedRef.current) { armedRef.current = false; }
        }}
        onDragEnd={(_, info) => {
          const past = info.offset.x <= -SWIPE_DELETE_PX;
          armedRef.current = false;
          if (past) commitDelete();
          else animate(x, 0, { type: "spring", stiffness: 500, damping: 35 });
        }}
        className="relative bg-background flex items-center gap-3 p-3 rounded-xl group"
      >
        <Icon className={`h-4 w-4 ${isMissed ? "text-destructive" : "text-muted-foreground"}`} />
        <div className="flex-1">
          <p className="text-sm font-medium flex items-center gap-2">
            {call.call_type === "video" ? "Video" : "Voice"} call
            {isMissed && <span className="text-[10px] text-destructive">Missed</span>}
          </p>
          <p className="text-xs text-muted-foreground">{formatCallTime(call.started_at)}</p>
        </div>
        {call.duration_seconds > 0 && (
          <span className="text-xs text-muted-foreground">{formatDurationShort(call.duration_seconds)}</span>
        )}
        <button onClick={() => { hapticWarning(); onDelete(call.id); }}
          aria-label="Delete call record"
          className="h-9 w-9 rounded-full flex items-center justify-center opacity-40 md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100 transition-opacity hover:bg-muted shrink-0">
          <Trash2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        </button>
      </motion.div>
    </div>
  );
};

export default CallHistoryRow;

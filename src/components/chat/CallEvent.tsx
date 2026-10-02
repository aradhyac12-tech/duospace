import { Phone, PhoneIncoming, PhoneMissed, PhoneOff, PhoneOutgoing, WifiOff } from "lucide-react";
import { classifyCallOutcome } from "@/lib/callOutcome";

interface CallEventProps {
  callType: string;
  status: string;
  direction: string;
  durationSeconds: number | null;
  createdAt: string;
  isMine: boolean;
  /** See src/lib/callOutcome.ts — distinguishes "rang out" from "actively
   *  declined", both of which share status==='missed'. Optional only so
   *  older cached timeline entries without it still render (as plain
   *  missed) rather than crashing. */
  declinedAt?: string | null;
}

const formatDuration = (seconds: number | null) => {
  if (!seconds || seconds <= 0) return "";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
};

const formatTime = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const CallEvent = ({ callType, status, direction, durationSeconds, createdAt, isMine, declinedAt }: CallEventProps) => {
  const isVideo = callType === "video";

  let icon = <Phone className="h-3.5 w-3.5" />;
  let label = "";
  let color = "text-muted-foreground";

  // "ringing"/"in_progress" are transient, not a real classifyCallOutcome
  // case — a call still actively ringing/connecting has no outcome yet.
  if (status === "ringing" || status === "in_progress") {
    icon = direction === "outgoing"
      ? <PhoneOutgoing className="h-3.5 w-3.5" />
      : <PhoneIncoming className="h-3.5 w-3.5" />;
    label = status === "ringing" ? "Ringing..." : "Calling...";
    color = "text-primary";
  } else {
    // CALL-HISTORY VALIDATION FIX: this used to check status === "declined"
    // / "no_answer" / "busy" directly — statuses the write side never
    // actually produced (it only ever wrote 'missed'+declined_at or
    // 'completed'), so those branches were silently dead code. Routed
    // through the same classifier CallHistoryRow now uses so this bubble
    // and the Calls tab's history list can't disagree with each other.
    const outcome = classifyCallOutcome({ status, duration_seconds: durationSeconds ?? 0, declined_at: declinedAt ?? null });
    if (outcome === "missed") {
      icon = <PhoneMissed className="h-3.5 w-3.5" />;
      label = isMine ? "No answer" : "Missed call";
      color = "text-destructive";
    } else if (outcome === "declined") {
      icon = <PhoneOff className="h-3.5 w-3.5" />;
      label = isMine ? "Call declined" : "Declined";
      color = "text-destructive";
    } else if (outcome === "busy") {
      icon = <PhoneOff className="h-3.5 w-3.5" />;
      label = "On another call";
      color = "text-muted-foreground";
    } else if (outcome === "cancelled") {
      icon = <PhoneMissed className="h-3.5 w-3.5" />;
      label = isMine ? "Cancelled" : "Call cancelled";
      color = "text-muted-foreground";
    } else if (outcome === "failed") {
      icon = <WifiOff className="h-3.5 w-3.5" />;
      label = "Call failed";
      color = "text-destructive";
    } else {
      icon = direction === "outgoing"
        ? <PhoneOutgoing className="h-3.5 w-3.5" />
        : <PhoneIncoming className="h-3.5 w-3.5" />;
      const dur = formatDuration(durationSeconds);
      label = `${isVideo ? "Video" : "Voice"} call${dur ? ` · ${dur}` : ""}`;
      color = "text-foreground";
    }
  }

  return (
    <div className="flex justify-center my-2">
      <div className={`flex items-center gap-2 px-4 py-1.5 rounded-full bg-muted/40 backdrop-blur-sm ${color}`}>
        {icon}
        <span className="text-[11px] font-medium">{label}</span>
        <span className="text-[10px] opacity-60">{formatTime(createdAt)}</span>
      </div>
    </div>
  );
};

export default CallEvent;

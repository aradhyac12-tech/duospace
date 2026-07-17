import { Phone, PhoneIncoming, PhoneMissed, PhoneOff, PhoneOutgoing } from "lucide-react";

interface CallEventProps {
  callType: string;
  status: string;
  direction: string;
  durationSeconds: number | null;
  createdAt: string;
  isMine: boolean;
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

const CallEvent = ({ callType, status, direction, durationSeconds, createdAt, isMine }: CallEventProps) => {
  const isVideo = callType === "video";
  const isMissed = status === "missed";
  const isDeclined = status === "declined";
  const isNoAnswer = status === "no_answer";
  const isBusy = status === "busy";
  const isCompleted = status === "completed";

  let icon = <Phone className="h-3.5 w-3.5" />;
  let label = "";
  let color = "text-muted-foreground";

  if (isMissed || isNoAnswer) {
    icon = <PhoneMissed className="h-3.5 w-3.5" />;
    label = isMine ? "No answer" : "Missed call";
    color = "text-destructive";
  } else if (isDeclined) {
    icon = <PhoneOff className="h-3.5 w-3.5" />;
    label = isMine ? "Call declined" : "Declined";
    color = "text-destructive";
  } else if (isBusy) {
    icon = <PhoneOff className="h-3.5 w-3.5" />;
    label = "On another call";
    color = "text-muted-foreground";
  } else if (isCompleted) {
    icon = direction === "outgoing"
      ? <PhoneOutgoing className="h-3.5 w-3.5" />
      : <PhoneIncoming className="h-3.5 w-3.5" />;
    const dur = formatDuration(durationSeconds);
    label = `${isVideo ? "Video" : "Voice"} call${dur ? ` · ${dur}` : ""}`;
    color = "text-foreground";
  } else {
    // ringing / in_progress
    icon = direction === "outgoing"
      ? <PhoneOutgoing className="h-3.5 w-3.5" />
      : <PhoneIncoming className="h-3.5 w-3.5" />;
    label = status === "ringing" ? "Ringing..." : "Calling...";
    color = "text-primary";
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

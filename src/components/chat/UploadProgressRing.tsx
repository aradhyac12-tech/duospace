/**
 * UploadProgressRing — progress indicator overlaid on media while uploading.
 *
 * REDESIGN: previously a hardcoded white stroke on a flat black/40 overlay,
 * which ignored the active theme entirely. Now built from the design-system
 * tokens (--primary, --background) so it follows every theme / Theme Studio
 * palette and light/dark mode: a frosted disc, a soft primary track, and a
 * primary arc that eases between real byte-progress values. Center shows an
 * upload arrow (not tiny 9px digits that were unreadable at 22px); the
 * percentage is exposed via aria-label and shown beside the ring at the
 * larger size only.
 */
import { ArrowUp, Check } from "lucide-react";

const UploadProgressRing = ({ progress, size = 40 }: { progress?: number; size?: number }) => {
  const stroke = size >= 36 ? 3 : 2.25;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = progress != null ? Math.max(0, Math.min(100, progress)) : undefined;
  const indeterminate = clamped == null;
  // Always show a sliver so 0% still reads as "started".
  const visible = indeterminate ? 28 : Math.max(4, clamped);
  const offset = circumference * (1 - visible / 100);
  const done = clamped != null && clamped >= 100;
  const icon = Math.round(size * 0.42);

  return (
    <div
      className="absolute inset-0 flex items-center justify-center bg-background/25 rounded-[inherit] pointer-events-none"
      role="status"
      aria-label={indeterminate ? "Sending" : `Sending, ${Math.round(clamped!)}%`}
    >
      <div className="flex flex-col items-center gap-1">
        <div
          className="relative flex items-center justify-center rounded-full bg-background/80 backdrop-blur-md shadow-sm"
          style={{ width: size + 6, height: size + 6 }}
        >
          <svg
            width={size} height={size} viewBox={`0 0 ${size} ${size}`}
            className={indeterminate ? "animate-spin motion-reduce:animate-none" : ""}
            style={{ transform: indeterminate ? undefined : "rotate(-90deg)" }}
          >
            <circle cx={size / 2} cy={size / 2} r={radius} fill="none"
              stroke="hsl(var(--primary) / 0.18)" strokeWidth={stroke} />
            <circle
              cx={size / 2} cy={size / 2} r={radius} fill="none"
              stroke="hsl(var(--primary))" strokeWidth={stroke} strokeLinecap="round"
              strokeDasharray={circumference} strokeDashoffset={offset}
              style={{ transition: indeterminate ? undefined : "stroke-dashoffset 300ms cubic-bezier(0.22,1,0.36,1)" }}
            />
          </svg>
          <span className="absolute inset-0 flex items-center justify-center text-primary">
            {done ? <Check style={{ width: icon, height: icon }} strokeWidth={2.75} />
                  : <ArrowUp style={{ width: icon, height: icon }} strokeWidth={2.5} />}
          </span>
        </div>
        {size >= 36 && clamped != null && !done && (
          <span className="px-1.5 py-0.5 rounded-full bg-background/80 backdrop-blur-md text-[10px] font-semibold text-foreground tabular-nums leading-none">
            {Math.round(clamped)}%
          </span>
        )}
      </div>
    </div>
  );
};

export default UploadProgressRing;

/**
 * UploadProgressRing — progress indicator overlaid on media messages while uploading.
 *
 * Shows:
 * - A circular progress ring (determinate when progress is given, indeterminate spinner otherwise)
 * - A percentage text in the center for clear feedback
 * - A dark overlay behind for readability
 *
 * The ring fills as resumableUpload's onProgress reports real bytes-sent.
 * For small single-chunk files, progress jumps from 0% to 100% — the
 * percentage text makes this transition clear.
 */
const UploadProgressRing = ({ progress, size = 40 }: { progress?: number; size?: number }) => {
  const stroke = 2.5;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = progress != null ? Math.max(0, Math.min(100, progress)) : undefined;
  const offset = clamped != null ? circumference * (1 - clamped / 100) : circumference * 0.75;

  return (
    <div
      className="absolute inset-0 flex items-center justify-center bg-black/40 rounded-[inherit]"
      role="status"
      aria-label={clamped != null ? `Sending, ${Math.round(clamped)}%` : "Sending"}
    >
      <div className="relative flex items-center justify-center">
        <svg
          width={size} height={size} viewBox={`0 0 ${size} ${size}`}
          className={clamped == null ? "animate-spin motion-reduce:animate-none" : ""}
          style={{ transform: "rotate(-90deg)" }}
        >
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth={stroke} />
          <circle
            cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="white" strokeWidth={stroke}
            strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={offset}
            style={{ transition: clamped != null ? "stroke-dashoffset 200ms linear" : undefined }}
          />
        </svg>
        {/* Percentage text in center — makes progress clear even for small files
            that jump from 0% to 100% in one chunk */}
        {clamped != null && (
          <span className="absolute text-[9px] font-bold text-white tabular-nums leading-none">
            {clamped >= 100 ? "✓" : `${clamped}`}
          </span>
        )}
        {clamped == null && (
          <span className="absolute text-[8px] font-medium text-white/80">...</span>
        )}
      </div>
    </div>
  );
};

export default UploadProgressRing;

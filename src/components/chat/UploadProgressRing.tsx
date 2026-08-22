// ─── UploadProgressRing ──────────────────────────────────────────────────────
// A small circular progress indicator overlaid on a media message's
// thumbnail while it's still uploading — the "circle like WhatsApp to know
// the progress" for photos/videos/files/voice notes. Two modes:
//   - `progress` given (0-100): a determinate ring, filling as
//     resumableUpload's onProgress reports real bytes-sent (see
//     src/lib/resumableUpload.ts). This is genuine progress, not simulated.
//   - `progress` omitted: an indeterminate spinner — used for the brief
//     window before the first progress callback fires, and for tiny
//     single-chunk uploads where "progress" isn't really meaningful.
// Respects reduced-motion the same way the rest of this app's motion does
// (a spinning ring is decorative animation, not information — the
// underlying "sending" state is also conveyed via MessageStatus's icon and
// the bubble's dimmed opacity, so hiding the spin doesn't lose information).
const UploadProgressRing = ({ progress, size = 34 }: { progress?: number; size?: number }) => {
  const stroke = 2.5;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = progress != null ? Math.max(0, Math.min(100, progress)) : undefined;
  const offset = clamped != null ? circumference * (1 - clamped / 100) : circumference * 0.75;

  return (
    <div
      className="absolute inset-0 flex items-center justify-center bg-black/35 rounded-[inherit]"
      role="status"
      aria-label={clamped != null ? `Sending, ${Math.round(clamped)}%` : "Sending"}
    >
      <svg
        width={size} height={size} viewBox={`0 0 ${size} ${size}`}
        className={clamped == null ? "animate-spin motion-reduce:animate-none" : ""}
        style={{ transform: "rotate(-90deg)" }}
      >
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="white" strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={offset}
          style={{ transition: clamped != null ? "stroke-dashoffset 180ms linear" : undefined }}
        />
      </svg>
    </div>
  );
};

export default UploadProgressRing;

import { scorePasswordStrength } from "@/lib/passwordStrength";
import { cn } from "@/lib/utils";

interface PasswordStrengthMeterProps {
  password: string;
  className?: string;
}

// Minimal, quiet indicator — 4 thin segments + a short label, matching the
// app's established "no unnecessary cards, no heavy chrome" design language
// rather than a boxed widget. Renders nothing for an empty password so it
// doesn't clutter the form before the person has typed anything.
const LEVEL_COLOR: Record<string, string> = {
  weak: "bg-destructive",
  fair: "bg-warning",
  good: "bg-info",
  strong: "bg-success",
};
const LEVEL_TEXT: Record<string, string> = {
  weak: "text-destructive",
  fair: "text-warning",
  good: "text-info",
  strong: "text-success",
};

const PasswordStrengthMeter = ({ password, className }: PasswordStrengthMeterProps) => {
  const { score, level, label } = scorePasswordStrength(password);
  if (level === "empty") return null;

  return (
    <div className={cn("flex items-center gap-2", className)} aria-live="polite">
      <div className="flex-1 flex gap-1" role="img" aria-label={`Password strength: ${label}`}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className={cn(
              "h-1 flex-1 rounded-full transition-colors duration-200",
              i < score ? LEVEL_COLOR[level] : "bg-border/60"
            )}
          />
        ))}
      </div>
      <span className={cn("text-[11px] font-medium shrink-0", LEVEL_TEXT[level])}>{label}</span>
    </div>
  );
};

export default PasswordStrengthMeter;

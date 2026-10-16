import { memo } from "react";
import { cn } from "@/lib/utils";

/**
 * A tiny, purely visual mock of DuoSpace — header, avatar, chat bubbles,
 * composer, bottom navigation with an active state — painted ONLY from a
 * derived token set (themeEngine.deriveTokens / customThemes.buildCustomThemeTokens).
 * It has no behaviour and fakes no features: it exists so a theme can be
 * understood at a glance before it is selected. Scoped inline styles (not the
 * live :root variables) are what let every card show a *different* theme.
 */
export interface ThemePreviewProps {
  tokens: Record<string, string>;
  /** "sm": shapes only, for picker cards. "md": real micro-copy, for Theme Studio. */
  size?: "sm" | "md";
  className?: string;
}

const ThemePreviewImpl = ({ tokens, size = "sm", className }: ThemePreviewProps) => {
  const c = (k: string, fallback = "0 0% 50%") => `hsl(${tokens[k] ?? fallback})`;
  const md = size === "md";
  const bg = c("--background"), card = c("--card"), border = c("--border");
  const fg = c("--foreground"), muted = c("--muted"), mutedFg = c("--muted-foreground");
  const primary = c("--primary"), primaryFg = c("--primary-foreground");
  const accentWash = c("--accent-muted", "0 0% 50% / 0.15");
  const glow = tokens["--ambient-glow"];
  const isDark = parseFloat((tokens["--background"] ?? "0 0% 50%").split(/\s+/)[2]) < 50;

  return (
    <div
      aria-hidden="true"
      className={cn("relative overflow-hidden rounded-xl border flex flex-col", md ? "gap-2.5 p-3 rounded-2xl" : "gap-1 p-1.5", className)}
      style={{
        background: bg,
        borderColor: border,
        // same ambient wash as .ambient-light — dark themes only
        backgroundImage: isDark && glow ? `radial-gradient(120% 60% at 50% -12%, hsl(${glow}), transparent 70%)` : undefined,
        backgroundRepeat: "no-repeat",
      }}
    >
      {/* header: avatar + identity */}
      <div className={cn("flex items-center", md ? "gap-2" : "gap-1")}>
        <span
          className={cn("shrink-0 rounded-full flex items-center justify-center font-semibold", md ? "h-7 w-7 text-[11px]" : "h-3 w-3")}
          style={{ background: primary, color: primaryFg }}
        >
          {md ? "A" : null}
        </span>
        {md ? (
          <span className="min-w-0 leading-tight">
            <span className="block text-[12px] font-semibold truncate" style={{ color: fg }}>Alex</span>
            <span className="block text-[10px] truncate" style={{ color: mutedFg }}>online</span>
          </span>
        ) : (
          <span className="h-1 w-1/3 rounded-full" style={{ background: mutedFg, opacity: 0.55 }} />
        )}
      </div>

      {/* conversation */}
      <div className={cn("flex flex-col", md ? "gap-1.5" : "gap-[3px]")}>
        <span
          className={cn("self-start rounded-2xl rounded-bl-[4px] border", md ? "px-2.5 py-1.5 text-[11px] max-w-[78%]" : "h-2 w-[62%]")}
          style={{ background: card, borderColor: border, color: fg }}
        >
          {md ? "Thinking of you ✨" : null}
        </span>
        <span
          className={cn("self-end rounded-2xl rounded-br-[4px]", md ? "px-2.5 py-1.5 text-[11px] max-w-[78%]" : "h-2 w-[48%]")}
          style={{ background: primary, color: primaryFg }}
        >
          {md ? "Same. See you tonight" : null}
        </span>
      </div>

      {/* composer */}
      <div className={cn("flex items-center", md ? "gap-1.5" : "gap-1")}>
        <span
          className={cn("flex-1 rounded-full border", md ? "h-7 px-3 flex items-center text-[10px]" : "h-2.5")}
          style={{ background: muted, borderColor: border, color: mutedFg }}
        >
          {md ? "Message" : null}
        </span>
        <span className={cn("shrink-0 rounded-full", md ? "h-7 w-7" : "h-2.5 w-2.5")} style={{ background: primary }} />
      </div>

      {/* bottom navigation with an active state */}
      <div
        className={cn("flex items-center justify-around rounded-full border", md ? "h-9 px-2" : "h-3 px-1")}
        style={{ background: card, borderColor: border }}
      >
        {[0, 1, 2, 3].map(i => (
          <span
            key={i}
            className={cn("rounded-full flex items-center justify-center", md ? "h-6 w-6" : "h-1.5 w-1.5")}
            style={i === 1 ? { background: accentWash } : undefined}
          >
            <span
              className={cn("rounded-full", md ? "h-2 w-2" : "h-1 w-1")}
              style={{ background: i === 1 ? primary : mutedFg, opacity: i === 1 ? 1 : 0.6 }}
            />
          </span>
        ))}
      </div>
    </div>
  );
};

export const ThemePreview = memo(ThemePreviewImpl);
export default ThemePreview;

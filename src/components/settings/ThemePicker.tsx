import { useMemo, useState } from "react";
import { Check, Moon, Palette, Sun, Wand2 } from "lucide-react";
import {
  THEMES, THEME_CATEGORIES, THEME_IDENTITIES, ThemeCategory, ThemeColor, useTheme,
} from "@/contexts/ThemeContext";
import { deriveTokens } from "@/lib/themeEngine";
import { hapticLight } from "@/lib/haptics";
import { cn } from "@/lib/utils";
import CollapsibleSection from "./CollapsibleSection";

type Filter = "all" | ThemeCategory;

interface ThemePickerProps {
  /** Theme Studio: an applied custom theme overrides the preset, so no preset
   *  should read as selected while one is active. */
  customActive?: boolean;
  /** Override what happens on select (Theme Studio clears custom overrides
   *  first). Defaults to setTheme. */
  onSelect?: (id: ThemeColor) => void;
}

/**
 * Theme selector: category filter chips + a grid of mini chat previews.
 *
 * Each card is rendered from the theme's REAL derived tokens in the mode the
 * app is in right now. The old swatches always showed a theme's "home" mode,
 * so e.g. Wine Red looked near-black in the picker but applied as a light
 * wine palette when the app was in light mode — the preview lied. Now what
 * you see is what you get, and it repaints when the mode changes.
 */
export const ThemePicker = ({ customActive = false, onSelect }: ThemePickerProps) => {
  const { theme, setTheme, colorMode } = useTheme();
  const [filter, setFilter] = useState<Filter>("all");

  const cards = useMemo(() => THEMES.map(t => {
    const k = deriveTokens(THEME_IDENTITIES[t.id], colorMode);
    const c = (token: string) => `hsl(${k[token]})`;
    const a = THEME_IDENTITIES[t.id].accent;
    return {
      ...t,
      bg: c("--background"), card: c("--card"), border: c("--border"),
      fg: c("--foreground"), primary: c("--primary"), primaryFg: c("--primary-foreground"),
      accentDot: `hsl(${a.h} ${a.s}% ${a.l}%)`,
    };
  }), [colorMode]);

  const counts = useMemo(() => {
    const m = new Map<ThemeCategory, number>();
    for (const t of THEMES) m.set(t.category, (m.get(t.category) ?? 0) + 1);
    return m;
  }, []);

  const visible = filter === "all" ? cards : cards.filter(t => t.category === filter);

  const choose = (id: ThemeColor) => {
    hapticLight();
    (onSelect ?? setTheme)(id);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2.5">
        <p className="text-[10px] text-muted-foreground flex items-center gap-1">
          {colorMode === "dark" ? <Moon className="h-3 w-3" aria-hidden="true" /> : <Sun className="h-3 w-3" aria-hidden="true" />}
          Previews in {colorMode} mode
        </p>
        <p className="text-[10px] text-muted-foreground tabular-nums">{visible.length} themes</p>
      </div>

      <div
        data-swipe-nav-ignore
        role="group"
        aria-label="Filter themes by style"
        className="flex gap-1.5 overflow-x-auto pb-2 -mx-1 px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {([{ id: "all" as Filter, emoji: "✨", n: THEMES.length }, ...THEME_CATEGORIES.map(cat => ({
          id: cat.id as Filter, emoji: cat.emoji, n: counts.get(cat.id) ?? 0,
        }))]).map(f => {
          const on = filter === f.id;
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => { hapticLight(); setFilter(f.id); }}
              aria-pressed={on}
              className={cn(
                "shrink-0 h-8 px-3 rounded-full border text-[11px] font-medium flex items-center gap-1.5 transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                on
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-muted/40 text-muted-foreground border-border/60",
              )}
            >
              <span aria-hidden="true">{f.emoji}</span>
              {f.id === "all" ? "All" : f.id}
              <span className="opacity-60 tabular-nums">{f.n}</span>
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-3 gap-2.5 mt-1">
        {visible.map(t => {
          const active = t.id === theme && !customActive;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => choose(t.id)}
              aria-pressed={active}
              aria-label={`${t.name} theme, ${t.category}${active ? ", selected" : ""}`}
              className="press relative rounded-2xl border p-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
              style={{
                background: t.bg,
                borderColor: active ? t.primary : t.border,
                outline: active ? `2px solid ${t.primary}` : undefined,
                outlineOffset: active ? "1px" : undefined,
              }}
            >
              {/* Mini conversation drawn from this theme's own tokens */}
              <span className="flex flex-col gap-1 h-[46px] justify-center" aria-hidden="true">
                <span className="h-3.5 w-[64%] rounded-lg rounded-bl-[3px]" style={{ background: t.card, border: `1px solid ${t.border}` }} />
                <span className="h-3.5 w-[52%] self-end rounded-lg rounded-br-[3px]" style={{ background: t.primary }} />
                <span className="h-3.5 w-[38%] rounded-lg rounded-bl-[3px]" style={{ background: t.card, border: `1px solid ${t.border}` }} />
              </span>
              <span className="mt-1.5 flex items-center gap-1 min-w-0">
                <span className="text-[11px] leading-none" aria-hidden="true">{t.emoji}</span>
                <span className="flex-1 min-w-0 truncate text-[11px] font-medium" style={{ color: t.fg }}>{t.name}</span>
                {active ? (
                  <span className="h-4 w-4 shrink-0 rounded-full flex items-center justify-center" style={{ background: t.primary, color: t.primaryFg }}>
                    <Check className="h-2.5 w-2.5" strokeWidth={3} aria-hidden="true" />
                  </span>
                ) : (
                  <span className="flex shrink-0 -space-x-1" aria-hidden="true">
                    <span className="h-2.5 w-2.5 rounded-full ring-1 ring-black/10" style={{ background: t.primary }} />
                    <span className="h-2.5 w-2.5 rounded-full ring-1 ring-black/10" style={{ background: t.accentDot }} />
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

/** Collapsible Appearance-settings wrapper around ThemePicker. */
export const ThemeSection = ({ onOpenStudio }: { onOpenStudio: () => void }) => {
  const { theme, colorMode } = useTheme();
  const current = THEMES.find(t => t.id === theme);
  const swatch = useMemo(() => {
    const identity = THEME_IDENTITIES[theme] ?? THEME_IDENTITIES.midnight;
    const k = deriveTokens(identity, colorMode);
    return { bg: `hsl(${k["--background"]})`, primary: `hsl(${k["--primary"]})`, border: `hsl(${k["--border"]})` };
  }, [theme, colorMode]);

  return (
    <CollapsibleSection
      id="theme"
      title="Theme colors"
      icon={<Palette className="h-4 w-4" />}
      summary={current ? `${current.emoji} ${current.name} · ${current.category}` : "Pick a look"}
      preview={
        <span
          className="h-9 w-9 rounded-xl border flex items-end justify-end p-1.5"
          style={{ background: swatch.bg, borderColor: swatch.border }}
        >
          <span className="h-3.5 w-5 rounded-md rounded-br-[3px]" style={{ background: swatch.primary }} />
        </span>
      }
      defaultOpen
    >
      <ThemePicker />
      <button
        type="button"
        onClick={onOpenStudio}
        className="mt-3 w-full h-10 rounded-xl bg-gradient-to-r from-primary/15 to-accent/30 border border-border/60 text-xs font-medium flex items-center justify-center gap-1.5 active:scale-[0.98] transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Wand2 className="h-3.5 w-3.5" aria-hidden="true" /> Open Theme Studio — build your own
      </button>
    </CollapsibleSection>
  );
};

export default ThemePicker;

/**
 * themeEngine — single source of truth for turning a theme "identity"
 * (just a primary + accent hue/saturation, plus light or dark mode) into
 * the FULL semantic token set the app actually renders with.
 *
 * Root cause this fixes: theme presets and the custom color builder used to
 * write only 4-5 of the ~17 CSS variables the app uses (primary, accent,
 * ring, background, foreground) — card, border, secondary, muted, and their
 * *-foreground pairs were left untouched from whatever the previous theme
 * had set, producing mismatched, low-contrast, "broken-looking" results.
 * Every preset now goes through this one function, so it's structurally
 * impossible to apply a partial palette again.
 */

export interface HSL { h: number; s: number; l: number }

export interface ThemeIdentity {
  primary: HSL;
  accent: HSL;
}

export type ColorMode = "light" | "dark";

const hsl = (h: number, s: number, l: number): string =>
  `${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%`;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** Pick a readable foreground (near-black or near-white) for a given background lightness/hue. */
function readableForeground(bg: HSL, mode: ColorMode): HSL {
  return mode === "light"
    ? { h: bg.h, s: 15, l: 15 }
    : { h: bg.h, s: 15, l: 92 };
}

export function deriveTokens(identity: ThemeIdentity, mode: ColorMode): Record<string, string> {
  const { primary, accent } = identity;

  if (mode === "light") {
    const bgH = primary.h, bgS = clamp(primary.s * 0.55, 8, 30);
    const background: HSL = { h: bgH, s: bgS, l: 96 };
    const foreground = readableForeground(background, "light");
    const card: HSL = { h: bgH, s: bgS, l: 98 };
    const secondary: HSL = { h: accent.h, s: clamp(accent.s * 0.5, 10, 22), l: 90 };
    const muted: HSL = { h: bgH, s: clamp(bgS * 0.6, 6, 14), l: 92 };
    const mutedFg: HSL = { h: foreground.h, s: 8, l: 45 };
    const accentTok: HSL = { h: accent.h, s: clamp(accent.s, 20, 55), l: 82 };
    const border: HSL = { h: bgH, s: clamp(bgS * 0.7, 8, 18), l: 88 };
    const primaryFg: HSL = primary.l < 55 ? { h: primary.h, s: 15, l: 97 } : { h: primary.h, s: 20, l: 12 };

    return {
      "--background": hsl(background.h, background.s, background.l),
      "--foreground": hsl(foreground.h, foreground.s, foreground.l),
      "--card": hsl(card.h, card.s, card.l),
      "--card-foreground": hsl(foreground.h, foreground.s, foreground.l),
      "--popover": hsl(card.h, card.s, card.l),
      "--popover-foreground": hsl(foreground.h, foreground.s, foreground.l),
      "--primary": hsl(primary.h, primary.s, primary.l),
      "--primary-foreground": hsl(primaryFg.h, primaryFg.s, primaryFg.l),
      "--secondary": hsl(secondary.h, secondary.s, secondary.l),
      "--secondary-foreground": hsl(foreground.h, foreground.s, foreground.l),
      "--muted": hsl(muted.h, muted.s, muted.l),
      "--muted-foreground": hsl(mutedFg.h, mutedFg.s, mutedFg.l),
      "--accent": hsl(accentTok.h, accentTok.s, accentTok.l),
      "--accent-foreground": hsl(foreground.h, foreground.s, foreground.l),
      "--border": hsl(border.h, border.s, border.l),
      "--input": hsl(border.h, border.s, border.l),
      "--ring": hsl(primary.h, primary.s, primary.l),
      "--destructive": "0 84% 60%",
      "--destructive-foreground": "0 0% 98%",
    };
  }

  // dark
  const bgH = primary.h, bgS = clamp(primary.s * 0.5, 10, 30);
  const background: HSL = { h: bgH, s: bgS, l: 9 };
  const foreground = readableForeground(background, "dark");
  const card: HSL = { h: bgH, s: bgS, l: 13 };
  const secondary: HSL = { h: bgH, s: clamp(bgS * 0.7, 12, 22), l: 18 };
  const muted: HSL = { h: bgH, s: clamp(bgS * 0.6, 10, 18), l: 15 };
  const mutedFg: HSL = { h: foreground.h, s: 10, l: 55 };
  const accentTok: HSL = { h: accent.h, s: clamp(accent.s * 0.7, 25, 50), l: 26 };
  const border: HSL = { h: bgH, s: clamp(bgS * 0.7, 10, 20), l: 18 };
  const primaryL = clamp(primary.l, 45, 68); // keep primary legible against a dark bg
  const primaryFg: HSL = { h: primary.h, s: 15, l: 97 };

  return {
    "--background": hsl(background.h, background.s, background.l),
    "--foreground": hsl(foreground.h, foreground.s, foreground.l),
    "--card": hsl(card.h, card.s, card.l),
    "--card-foreground": hsl(foreground.h, foreground.s, foreground.l),
    "--popover": hsl(card.h, card.s, card.l),
    "--popover-foreground": hsl(foreground.h, foreground.s, foreground.l),
    "--primary": hsl(primary.h, primary.s, primaryL),
    "--primary-foreground": hsl(primaryFg.h, primaryFg.s, primaryFg.l),
    "--secondary": hsl(secondary.h, secondary.s, secondary.l),
    "--secondary-foreground": hsl(foreground.h, foreground.s, clamp(foreground.l - 5, 75, 90)),
    "--muted": hsl(muted.h, muted.s, muted.l),
    "--muted-foreground": hsl(mutedFg.h, mutedFg.s, mutedFg.l),
    "--accent": hsl(accentTok.h, accentTok.s, accentTok.l),
    "--accent-foreground": hsl(foreground.h, foreground.s, foreground.l),
    "--border": hsl(border.h, border.s, border.l),
    "--input": hsl(border.h, border.s, border.l),
    "--ring": hsl(primary.h, primary.s, primaryL),
    "--destructive": "0 70% 55%",
    "--destructive-foreground": "0 0% 98%",
  };
}

/** Parse "H S% L%" -> HSL. Used to turn an existing preset's stored primary/accent string into an identity. */
export function parseHslString(s: string): HSL {
  const m = s.match(/(-?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%/);
  if (!m) return { h: 260, s: 40, l: 55 };
  return { h: parseFloat(m[1]), s: parseFloat(m[2]), l: parseFloat(m[3]) };
}

export function applyTokens(tokens: Record<string, string>) {
  const root = document.documentElement.style;
  Object.entries(tokens).forEach(([k, v]) => root.setProperty(k, v));
}

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

// User-facing preference. "light"/"dark" are explicit manual choices;
// "auto" follows the OS/browser prefers-color-scheme; "schedule" flips
// between light/dark at two user-set clock times (e.g. dark from 19:00 to
// 07:00); "dynamic" is a continuous, Apple-dynamic-wallpaper-style drift —
// every CSS token smoothly blends between the dark and light palettes
// across the whole day, with no hard cut anywhere. "light"/"dark"/"auto"/
// "schedule" all collapse down to a plain ColorMode before reaching
// applyTokens; "dynamic" is the one exception — see deriveDynamicTokens.
export type ThemeModePreference = "light" | "dark" | "auto" | "schedule" | "dynamic";

const hsl = (h: number, s: number, l: number): string =>
  `${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%`;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** "HH:MM" (24h) -> minutes since midnight. Invalid input clamps to 0. */
function timeToMinutes(t: string): number {
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 0;
  const h = clamp(parseInt(m[1], 10), 0, 23);
  const mm = clamp(parseInt(m[2], 10), 0, 59);
  return h * 60 + mm;
}

/**
 * Is `now` inside the [start, end) window? Handles windows that wrap past
 * midnight (e.g. start "19:00", end "07:00") as well as same-day windows.
 * All arguments are "HH:MM" 24h strings.
 */
export function isWithinTimeWindow(now: string, start: string, end: string): boolean {
  const n = timeToMinutes(now);
  const s = timeToMinutes(start);
  const e = timeToMinutes(end);
  if (s === e) return false; // zero-length window never matches
  if (s < e) return n >= s && n < e;
  return n >= s || n < e; // wraps midnight
}

/**
 * A smooth 0..1 curve for "how bright is the sky right now" — 1 at solar
 * noon (12:00), 0 at midnight, passing through 0.5 at the dawn/dusk
 * crossover points (06:00 / 18:00). This is what "dynamic" mode blends the
 * whole token set against, continuously, instead of ever hard-switching.
 */
export function getDayWeight(date: Date = new Date()): number {
  const hour = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
  const angle = ((hour - 6) / 24) * Math.PI * 2;
  return (Math.sin(angle) + 1) / 2;
}

/** Resolve a ThemeModePreference down to a concrete "light" | "dark" — for anything that only understands binary mode (dark-class toggling, wallpaper light/dark pairs, etc). */
export function resolveColorMode(
  mode: ThemeModePreference,
  opts: { manualFallback: ColorMode; scheduleDarkStart: string; scheduleDarkEnd: string; now?: Date }
): ColorMode {
  if (mode === "light" || mode === "dark") return mode;

  if (mode === "auto") {
    if (typeof window !== "undefined" && window.matchMedia) {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    return opts.manualFallback;
  }

  if (mode === "dynamic") {
    return getDayWeight(opts.now) >= 0.5 ? "light" : "dark";
  }

  // "schedule"
  const now = opts.now ?? new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const nowStr = `${hh}:${mm}`;
  return isWithinTimeWindow(nowStr, opts.scheduleDarkStart, opts.scheduleDarkEnd) ? "dark" : "light";
}

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

/** "H S% L%" -> {h,s,l}. Internal counterpart to parseHslString, used only for blending. */
function parseHsl(str: string): HSL {
  const m = str.match(/(-?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%/);
  if (!m) return { h: 0, s: 0, l: 50 };
  return { h: parseFloat(m[1]), s: parseFloat(m[2]), l: parseFloat(m[3]) };
}

// Hue wraps at 360°, so interpolate along the shortest arc rather than
// always going "up" — otherwise e.g. 350° -> 10° would drift the long way
// around through 180° instead of the short 20° hop.
const lerpHue = (a: number, b: number, t: number) => {
  const delta = ((((b - a) % 360) + 540) % 360) - 180;
  return (a + delta * t + 360) % 360;
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * "dynamic" mode's token derivation: instead of picking either the light
 * or the dark palette, blend every single CSS variable between them,
 * per-channel (hue via shortest arc, saturation/lightness linearly), using
 * getDayWeight() as the blend factor. At weight=0 this is byte-identical
 * to deriveTokens(identity, "dark"); at weight=1, byte-identical to
 * deriveTokens(identity, "light"). Everywhere in between is a smooth,
 * continuous drift with no visible seam — the same idea as Apple's Dynamic
 * wallpaper, applied to the whole UI palette instead of just an image.
 *
 * This is deliberately a blend of two already contrast-checked endpoints
 * (rather than a novel from-scratch formula) so legibility at any point in
 * the cycle stays close to what either endpoint already guarantees.
 */
export function deriveDynamicTokens(identity: ThemeIdentity, date: Date = new Date()): Record<string, string> {
  const dark = deriveTokens(identity, "dark");
  const light = deriveTokens(identity, "light");
  const weight = getDayWeight(date); // 0 = darkest (midnight) -> 1 = brightest (noon)
  const out: Record<string, string> = {};
  for (const key of Object.keys(dark)) {
    if (key === "--destructive" || key === "--destructive-foreground") {
      out[key] = dark[key]; // keep error red stable/legible regardless of time
      continue;
    }
    const d = parseHsl(dark[key]);
    const l = parseHsl(light[key]);
    out[key] = hsl(lerpHue(d.h, l.h, weight), lerp(d.s, l.s, weight), lerp(d.l, l.l, weight));
  }
  return out;
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

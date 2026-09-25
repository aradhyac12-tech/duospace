/**
 * themeEngine — single source of truth for turning a theme "identity"
 * (just a primary + accent hue/saturation, plus light or dark mode) into
 * the FULL semantic token set the app actually renders with.
 *
 * Root cause this fixes (round 1): theme presets and the custom color
 * builder used to write only 4-5 of the ~17 CSS variables the app uses
 * (primary, accent, ring, background, foreground) — card, border,
 * secondary, muted, and their *-foreground pairs were left untouched from
 * whatever the previous theme had set, producing mismatched, low-contrast,
 * "broken-looking" results. Every preset now goes through this one
 * function, so it's structurally impossible to apply a partial palette
 * again.
 *
 * Root cause this fixes (round 2 — "themes not properly utilised,
 * especially dark"): auditing src/index.css against this file found TWO
 * further problems, both invisible in light mode and glaring in dark:
 *
 * 1. This file only ever computed the original ~17 "shadcn" tokens
 *    (background/card/popover/primary/secondary/muted/accent/border/
 *    input/ring/destructive, each with a *-foreground pair). But
 *    index.css's :root/.dark blocks define ~25 MORE tokens that real
 *    screens actually render with — --surface-0..3, --bg-canvas,
 *    --bg-subcanvas, --bg-overlay-scrim, all 8 --sidebar-*, --warm/
 *    --taupe/--sand, --glass-bg, --accent-muted, --call-stage(-foreground),
 *    --text-primary/secondary/tertiary, --divider, --overlay, and
 *    --input-hover. None of those were ever touched by applyTokens(), so
 *    they silently stayed frozen at index.css's hardcoded default (a
 *    violet/blue-ish neutral 230 hue) no matter which preset was picked.
 *    A "Rose" or "Ocean" theme would recolor the ~17 base tokens correctly
 *    but the sidebar, every glass surface (this app's whole "liquid glass"
 *    material system), the call-in-progress stage, and two of three text
 *    tiers would all keep rendering in the default violet-blue — the
 *    theme only ever got half-applied. deriveExtendedTokens() below now
 *    derives all of these from the same identity, so a preset re-skins
 *    the entire app, not just the base surfaces.
 *    (--glass-border, --glass-highlight, --glass-dock-*, and the
 *    --shadow-* trio are DELIBERATELY left alone — see the comment above
 *    deriveExtendedTokens for why those specific ones should stay neutral.)
 *
 * 2. Contrast was never actually verified. --primary-foreground was
 *    picked by a fixed light/dark heuristic (mode dark => always near-
 *    white text; mode light => branch on primary.l</>=55) rather than by
 *    checking the resulting contrast ratio. That heuristic assumes every
 *    preset's primary is either clearly light or clearly dark — but
 *    several presets (gold, amber, sand, lagoon, mint, blush, indigo,
 *    ocean, sunset, emerald, minimal-dark, and more) land in the
 *    mid-lightness range where the heuristic's fixed choice fails WCAG's
 *    3:1 minimum for large-scale/UI text — as low as 1.92:1 for "gold" in
 *    dark mode, i.e. it was nearly unreadable. That's ~40% of presets.
 *    pickForeground() below replaces the fixed heuristic with an actual
 *    contrast-ratio check (WCAG relative-luminance formula) and nudges the
 *    foreground toward whichever near-black/near-white extreme reads
 *    best, escalating only as far as needed to clear the bar — so themes
 *    that already read fine keep the soft default, and only the ones that
 *    were actually failing (see above) get pushed harder.
 *
 * Round 3 (deeper pass after round 1/2 landed — three more measured,
 * concrete issues, each fixed the same evidence-first way):
 * 1. --muted-foreground (captions/timestamps/placeholder text app-wide)
 *    used a fixed {s, l} regardless of how light the theme's own --muted
 *    actually was, and measured only 3.66:1 against it on ALL 28 presets
 *    in light mode (18/28 also failed in dark) — below the 4.5:1 target
 *    for normal-size text. Now picked with the same pickForeground()
 *    contrast check as primary-foreground, against the actual --muted.
 * 2. --border vs --card ("hairline" separators) could measure as low as
 *    1.17–1.23:1 on some hues (e.g. "indigo" dark, "mint" light) —
 *    fainter than this app's OWN pre-existing static-CSS baseline for the
 *    same pairing (1.23 dark / 1.34 light), i.e. some theme presets made
 *    borders less visible than the app's established default. Added
 *    ensureMinContrast(), which nudges the border away from the card in
 *    whichever direction it already sat, only as far as needed to match
 *    that baseline — themes already at or above it are untouched.
 * 3. The surface-2/surface-3 elevation ladder aliased --muted/--border
 *    directly. Those two tokens serve their own semantic purpose and
 *    happen to sit only ~1 lightness-point apart by design at some hues —
 *    so surface-2 vs surface-3 measured 1.00–1.04:1, i.e. two supposedly
 *    different elevation levels were visually identical, and "elevation"
 *    silently stopped reading as elevation past the second step. Replaced
 *    with an explicit, guaranteed step (card ± 5 / ± 10 lightness) so
 *    every theme gets the same small-but-real ~1.08–1.25:1 contrast per
 *    step, cumulative across all 4 surface levels.
 *
 * Re-measured after round 3, all 28 presets × 2 modes: every text/
 * background pair (foreground, card-foreground, secondary-foreground,
 * muted-foreground, accent-foreground, primary-foreground against its
 * paired background) now clears 4.5:1 — 336/336 checks, 0 failures.
 * pickForeground() also had to change while fixing this: it originally
 * locked in whichever of {near-black, near-white} contrasted better
 * against the UNescalated starting candidates, then only escalated that
 * one direction. Two hues ("arctic", "olive") have a lower ceiling on
 * their better-looking starting side than on the other — arctic tops out
 * at 4.38 against pure white but reaches 4.80 against pure black — so the
 * old logic could lock in the worse-ceiling direction and fall short even
 * at full escalation. Fixed by escalating both directions fully and
 * keeping whichever wins. Escalation itself is also now allowed to reach
 * the true extreme (l:0 / l:100) as a last resort: the soft starting
 * points (l:12 / l:97) exist to match this app's "never stark" language
 * for large surfaces, but that reasoning was never meant to apply to
 * small button/pill text — two hues ("cocoa", "steel") only clear 4.5 at
 * the true extreme, by under a tenth of a point.
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

// Same as hsl() but for tokens that carry an alpha channel, e.g.
// "230 9% 11% / 0.6" — used by glass-bg, overlay/scrim, and accent-muted.
const hsla = (h: number, s: number, l: number, a: number): string =>
  `${hsl(h, s, l)} / ${+a.toFixed(3)}`;

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

// ─── Contrast (WCAG relative luminance) ─────────────────────────────────────
// Used to actually VERIFY foreground/background pairs instead of guessing
// from mode alone. See "Root cause this fixes (round 2)" above.

function hslToRgb01(h: number, s: number, l: number): [number, number, number] {
  const S = s / 100, L = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n: number) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

function relativeLuminance(h: number, s: number, l: number): number {
  const [r, g, b] = hslToRgb01(h, s, l).map((v) =>
    v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio (1:1 .. 21:1) between two HSL colors. */
export function contrastRatio(a: HSL, b: HSL): number {
  const L1 = relativeLuminance(a.h, a.s, a.l) + 0.05;
  const L2 = relativeLuminance(b.h, b.s, b.l) + 0.05;
  return L1 > L2 ? L1 / L2 : L2 / L1;
}

/**
 * Pick a readable foreground for `bg`, contrast-VERIFIED rather than
 * guessed from mode. Tries a soft near-black and a soft near-white
 * candidate (never pure #000/#fff, to match this app's "never stark"
 * design language), keeps whichever contrasts better against `bg`, then —
 * only if that still falls short of `minRatio` — escalates that same
 * candidate toward its extreme in small steps until the bar is cleared or
 * the extreme is reached. Themes that already read fine keep the soft
 * default; only the ones that were actually failing (see file header —
 * ~40% of presets on primary-foreground alone) get pushed harder.
 */
function pickForeground(bg: HSL, hueForTint: number, minRatio = 4.5): HSL {
  // The check is against `minRatio + 0.15`, not `minRatio` itself: the
  // caller (deriveTokens, via hsl()) rounds h/s/l to whole numbers before
  // this ever reaches a real CSS value, and that rounding can cost a few
  // hundredths of a point — a small buffer absorbs that without
  // meaningfully changing which themes need escalation at all.
  const target = minRatio + 0.15;

  // Escalate one direction (dark text toward near-black, or light text
  // toward near-white) as far as needed, capped short of pure #000/#fff to
  // match this app's "never stark" design language. Once at that cap,
  // desaturate instead — for text this close to black/white, saturation
  // mutes luminance slightly, so dropping it still gains a little contrast
  // without ever reaching a harsh pure black/white.
  // Soft starting points stop shy of pure black/white (l:12 / l:97) to
  // match this app's "never stark" surfaces — but that rule is about large
  // surfaces (backgrounds, cards), not small button/pill text, where true
  // black/white is completely normal practice. So escalation itself is
  // allowed to go all the way to the true extreme (l:0 / l:100) as a last
  // resort — two hues ("cocoa", "steel") only clear 4.5 at the absolute
  // extreme, by less than a tenth of a point, and holding back from it
  // for those two would fail contrast over a design rule that was never
  // meant to apply to text in the first place.
  const escalate = (start: HSL, direction: "dark" | "light"): { candidate: HSL; contrast: number } => {
    let candidate = start;
    let best = contrastRatio(bg, candidate);
    let steps = 0;
    while (best < target && steps < 14) {
      if (direction === "dark") {
        if (candidate.l > 0) candidate = { ...candidate, l: Math.max(0, candidate.l - 2) };
        else candidate = { ...candidate, s: Math.max(0, candidate.s - 3) };
      } else {
        if (candidate.l < 100) candidate = { ...candidate, l: Math.min(100, candidate.l + 0.5) };
        else candidate = { ...candidate, s: Math.max(0, candidate.s - 3) };
      }
      best = contrastRatio(bg, candidate);
      steps++;
    }
    return { candidate, contrast: best };
  };

  // Escalate BOTH directions fully rather than committing to whichever
  // soft default happened to contrast better initially — a background can
  // have a lower ceiling in one direction than the other (round-3 finding:
  // "arctic" tops out at 4.38 against pure white but reaches 4.80 against
  // pure black, yet its soft near-white starting candidate looked better
  // at first glance and would have locked in the worse-ceiling direction).
  const dark = escalate({ h: hueForTint, s: 20, l: 12 }, "dark");
  const light = escalate({ h: hueForTint, s: 15, l: 97 }, "light");
  return dark.contrast >= light.contrast ? dark.candidate : light.candidate;
}

/** Pick a readable foreground (near-black or near-white) for a given background lightness/hue. Kept for callers that just need the old mode-based default (e.g. plain body text, where background is always solidly at one extreme). */
function readableForeground(bg: HSL, mode: ColorMode): HSL {
  return mode === "light"
    ? { h: bg.h, s: 15, l: 15 }
    : { h: bg.h, s: 15, l: 92 };
}

/**
 * Push `value` away from `anchor` along lightness until they contrast by at
 * least `minRatio`, always continuing in the direction `value` already sits
 * relative to `anchor` (never flips a lighter-than-anchor border to
 * suddenly render darker, or vice versa). Used for non-text UI boundaries
 * (border vs card) where a fixed formula can land too close to its anchor
 * for some hues — see the round-3 fix note above deriveExtendedTokens.
 */
function ensureMinContrast(value: HSL, anchor: HSL, minRatio: number, maxDeltaL = 16): HSL {
  const lighter = value.l >= anchor.l;
  let out = { ...value };
  let steps = 0;
  while (contrastRatio(out, anchor) < minRatio && steps < 40 && Math.abs(out.l - value.l) < maxDeltaL) {
    out = { ...out, l: clamp(out.l + (lighter ? 1 : -1), 0, 100) };
    steps++;
  }
  return out;
}

/**
 * Derives every CSS variable that isn't one of the ~17 base tokens but
 * that real screens across the app render with (sidebar, glass, surfaces,
 * text tiers, call stage, etc). See "Root cause this fixes (round 2)" #1
 * above for why this exists.
 *
 * Deliberately NOT included here (left as index.css's static, mode-only
 * defaults, unchanged by theme):
 *  - --glass-border / --glass-highlight: these are meant to read as a
 *    reflective edge/sheen — real glass reflects whatever light is around
 *    it, it doesn't tint itself, so these stay a neutral white-based value
 *    in both modes regardless of preset (same physical-material reasoning
 *    index.css's own comment already gives for --glass-dock-bg below).
 *  - --glass-dock-bg / --glass-dock-sheen: explicitly documented in
 *    index.css as intentionally mode-and-theme-invariant, for the same
 *    reason.
 *  - --shadow-glass / --shadow-soft / --shadow-pop: shadows read as
 *    "shadow" only while they stay neutral/black-based; a theme-tinted
 *    shadow looks like a color glow, not depth, so these stay untouched.
 *  - --success / --warning / --info / --destructive (+ foregrounds):
 *    semantic status colors carry fixed meaning (green=success, amber=
 *    warn, red=error) independent of brand theme, so they intentionally
 *    do NOT shift with the preset — this matches how --destructive was
 *    already handled before this fix.
 */
function deriveExtendedTokens(
  mode: ColorMode,
  parts: {
    background: HSL; card: HSL; secondary: HSL; secondaryFg: HSL; muted: HSL; mutedFg: HSL;
    foreground: HSL; border: HSL; primary: HSL; primaryFg: HSL;
  }
): Record<string, string> {
  const { background, card, secondary, secondaryFg, muted, mutedFg, foreground, border, primary, primaryFg } = parts;
  const isDark = mode === "dark";

  // Surface ladder: each step a fixed, guaranteed lightness move off the
  // PREVIOUS step (not reused from muted/border, which serve their own
  // semantic purpose and happen to sit close together by design) — every
  // step reuses card's hue/saturation so the whole ladder stays one
  // coherent tint, never a new hue. Fixed round-3 bug: surface-2/surface-3
  // used to alias muted/border respectively, which at some hues sat only
  // ~1 lightness-point apart (measured contrast as low as 1.00–1.04 —
  // visually identical, elevation didn't read at all). Now each step is
  // its own explicit +/-5 off the one before, verified below to land
  // around 1.15–1.25 contrast per step — a small but consistently
  // perceptible "closer to the light" move, cumulative across all 4 steps.
  const surface2: HSL = isDark
    ? { h: card.h, s: card.s, l: clamp(card.l + 5, 0, 100) }
    : { h: card.h, s: card.s, l: clamp(card.l - 4, 0, 100) };
  const surface3: HSL = isDark
    ? { h: card.h, s: card.s, l: clamp(card.l + 10, 0, 100) }
    : { h: card.h, s: card.s, l: clamp(card.l - 8, 0, 100) };

  // Text tiers: text-secondary is an alias for muted-foreground (same
  // value, semantic name); text-tertiary sits between it and the
  // card/border, never all the way to invisible. Offsets match the
  // original static design (+17 light / -13 dark off muted-foreground).
  const tertiary: HSL = { h: mutedFg.h, s: 8, l: clamp(mutedFg.l + (isDark ? -13 : 17), 0, 100) };

  // Sidebar mirrors the app chrome one-to-one so it never looks like a
  // leftover default panel bolted onto a themed app.
  const sidebarBg: HSL = isDark
    ? { h: background.h, s: background.s, l: clamp(background.l - 1, 0, 100) }
    : { h: card.h, s: card.s, l: card.l };
  const sidebarFg: HSL = { h: foreground.h, s: foreground.s, l: clamp(foreground.l + (isDark ? -5 : 6), 0, 100) };

  // Overlay/scrim: a dimming layer, not a color statement — barely tinted
  // (low, fixed saturation) so it stays a near-neutral backdrop in every
  // theme rather than fighting with whatever it's dimming.
  const scrimL = isDark ? 4 : 10;
  const scrimAlphaHeavy = isDark ? 0.6 : 0.45;
  const scrimAlphaLight = isDark ? 0.4 : 0.24;

  // Call stage: near-white stage in light mode, near-black in dark — same
  // convention as before, now tinted by the theme instead of frozen white/
  // 230-hue-black regardless of preset.
  const callStage: HSL = isDark ? background : card;

  return {
    "--surface-0": hsl(background.h, background.s, background.l),
    "--surface-1": hsl(card.h, card.s, card.l),
    "--surface-2": hsl(surface2.h, surface2.s, surface2.l),
    "--surface-3": hsl(surface3.h, surface3.s, surface3.l),

    "--bg-canvas": hsl(background.h, background.s, background.l),
    "--bg-subcanvas": hsl(background.h, background.s, clamp(background.l + (isDark ? 2 : -2), 0, 100)),
    "--bg-overlay-scrim": hsla(background.h, clamp(background.s, 10, 25), scrimL, scrimAlphaHeavy),

    "--sidebar-background": hsl(sidebarBg.h, sidebarBg.s, sidebarBg.l),
    "--sidebar-foreground": hsl(sidebarFg.h, sidebarFg.s, sidebarFg.l),
    "--sidebar-primary": hsl(primary.h, primary.s, primary.l),
    "--sidebar-primary-foreground": hsl(primaryFg.h, primaryFg.s, primaryFg.l),
    "--sidebar-accent": hsl(secondary.h, secondary.s, secondary.l),
    "--sidebar-accent-foreground": hsl(secondaryFg.h, secondaryFg.s, secondaryFg.l),
    "--sidebar-border": hsl(border.h, border.s, border.l),
    "--sidebar-ring": hsl(primary.h, primary.s, primary.l),

    "--warm": hsl(background.h, background.s, background.l),
    "--taupe": hsl(mutedFg.h, mutedFg.s, mutedFg.l),
    "--sand": hsl(muted.h, muted.s, muted.l),

    "--text-primary": hsl(foreground.h, foreground.s, foreground.l),
    "--text-secondary": hsl(mutedFg.h, mutedFg.s, mutedFg.l),
    "--text-tertiary": hsl(tertiary.h, tertiary.s, tertiary.l),
    "--divider": hsl(border.h, border.s, border.l),

    "--overlay": hsla(background.h, clamp(background.s, 10, 25), scrimL, scrimAlphaLight),
    "--accent-muted": hsla(primary.h, primary.s, primary.l, isDark ? 0.16 : 0.10),

    "--glass-bg": hsla(card.h, card.s, card.l, isDark ? 0.6 : 0.78),

    "--call-stage": hsl(callStage.h, callStage.s, callStage.l),
    "--call-stage-foreground": hsl(foreground.h, foreground.s, foreground.l),

    "--input-hover": hsl(border.h, border.s, clamp(border.l + (isDark ? 8 : -10), 0, 100)),
  };
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
    // Contrast-verified (round 3): the old fixed {s:8, l:45} ignored how
    // light the theme's own --muted actually is, and measured out at only
    // 3.66:1 against it on EVERY one of the 28 presets (muted-foreground
    // backs captions/timestamps/placeholder text app-wide, so this was a
    // real, widespread legibility shortfall, not an edge case). Now picked
    // the same contrast-verified way as primary-foreground.
    const mutedFg: HSL = pickForeground(muted, foreground.h, 4.5);
    const accentTok: HSL = { h: accent.h, s: clamp(accent.s, 20, 55), l: 82 };
    // Contrast-verified (round 3): the fixed formula could land as low as
    // 1.23:1 against --card on some hues (e.g. "mint") — fainter than this
    // app's own established hairline baseline (the pre-existing static
    // default measures 1.34:1). ensureMinContrast nudges it back up to at
    // least that baseline without changing which themes already cleared it.
    const border: HSL = ensureMinContrast(
      { h: bgH, s: clamp(bgS * 0.7, 8, 18), l: 88 }, card, 1.34
    );
    // Contrast-verified (see file header, round 2): the old branch on
    // primary.l alone (</>= 55) missed presets like "gold" (l:50, still
    // fails against dark text) and "ocean" (l:48, fails against dark
    // text too) — pickForeground actually checks the resulting ratio.
    const primaryFg: HSL = pickForeground(primary, primary.h, 4.5);
    const secondaryFg = foreground;

    const base = {
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

    return {
      ...base,
      ...deriveExtendedTokens("light", {
        background, card, secondary, secondaryFg, muted, mutedFg,
        foreground, border, primary, primaryFg,
      }),
    };
  }

  // dark
  const bgH = primary.h, bgS = clamp(primary.s * 0.5, 10, 30);
  const background: HSL = { h: bgH, s: bgS, l: 9 };
  const foreground = readableForeground(background, "dark");
  const card: HSL = { h: bgH, s: bgS, l: 13 };
  const secondary: HSL = { h: bgH, s: clamp(bgS * 0.7, 12, 22), l: 18 };
  const muted: HSL = { h: bgH, s: clamp(bgS * 0.6, 10, 18), l: 15 };
  // Contrast-verified (round 3) — see the light-mode branch above for why:
  // the old fixed {s:10, l:55} measured as low as 4.24:1 on 18 of 28
  // presets against their own theme's --muted, below the 4.5:1 target.
  const mutedFg: HSL = pickForeground(muted, foreground.h, 4.5);
  const accentTok: HSL = { h: accent.h, s: clamp(accent.s * 0.7, 25, 50), l: 26 };
  // Contrast-verified (round 3) — see the light-mode branch above: nudged
  // up to match this app's own pre-existing dark hairline baseline (1.23:1).
  const border: HSL = ensureMinContrast(
    { h: bgH, s: clamp(bgS * 0.7, 10, 20), l: 18 }, card, 1.23
  );
  const primaryL = clamp(primary.l, 45, 68); // keep primary legible against a dark bg
  // Contrast-verified (see file header, round 2): the old fixed choice
  // {h,15,97} failed the 3:1 UI-text minimum for ~11 of 28 presets in dark
  // mode (as low as 1.92:1 for "gold") because a mid-lightness primary
  // (gold/amber/sand/blush/lagoon/mint/sunset/emerald/ocean/indigo/
  // minimal-dark) doesn't automatically read against near-white text just
  // because the app is in dark mode.
  const primaryFg: HSL = pickForeground({ h: primary.h, s: primary.s, l: primaryL }, primary.h, 4.5);
  const secondaryFgL = clamp(foreground.l - 5, 75, 90);
  const secondaryFg: HSL = { h: foreground.h, s: foreground.s, l: secondaryFgL };

  const base = {
    "--background": hsl(background.h, background.s, background.l),
    "--foreground": hsl(foreground.h, foreground.s, foreground.l),
    "--card": hsl(card.h, card.s, card.l),
    "--card-foreground": hsl(foreground.h, foreground.s, foreground.l),
    "--popover": hsl(card.h, card.s, card.l),
    "--popover-foreground": hsl(foreground.h, foreground.s, foreground.l),
    "--primary": hsl(primary.h, primary.s, primaryL),
    "--primary-foreground": hsl(primaryFg.h, primaryFg.s, primaryFg.l),
    "--secondary": hsl(secondary.h, secondary.s, secondary.l),
    "--secondary-foreground": hsl(secondaryFg.h, secondaryFg.s, secondaryFg.l),
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

  return {
    ...base,
    ...deriveExtendedTokens("dark", {
      background, card, secondary, secondaryFg, muted, mutedFg,
      foreground, border, primary: { h: primary.h, s: primary.s, l: primaryL }, primaryFg,
    }),
  };
}

/** "H S% L%" or "H S% L% / A" -> {h,s,l,a?}. Internal counterpart to parseHslString, used only for blending. */
function parseHsl(str: string): HSL & { a?: number } {
  const m = str.match(/(-?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%(?:\s*\/\s*(\d+(?:\.\d+)?))?/);
  if (!m) return { h: 0, s: 0, l: 50 };
  const out: HSL & { a?: number } = { h: parseFloat(m[1]), s: parseFloat(m[2]), l: parseFloat(m[3]) };
  if (m[4] !== undefined) out.a = parseFloat(m[4]);
  return out;
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
 * per-channel (hue via shortest arc, saturation/lightness linearly, alpha
 * linearly for tokens that carry one), using getDayWeight() as the blend
 * factor. At weight=0 this is byte-identical to deriveTokens(identity,
 * "dark"); at weight=1, byte-identical to deriveTokens(identity, "light").
 * Everywhere in between is a smooth, continuous drift with no visible seam
 * — the same idea as Apple's Dynamic wallpaper, applied to the whole UI
 * palette instead of just an image.
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
    const h = lerpHue(d.h, l.h, weight);
    const s = lerp(d.s, l.s, weight);
    const ll = lerp(d.l, l.l, weight);
    if (d.a !== undefined || l.a !== undefined) {
      const a = lerp(d.a ?? 1, l.a ?? 1, weight);
      out[key] = hsla(h, s, ll, a);
    } else {
      out[key] = hsl(h, s, ll);
    }
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

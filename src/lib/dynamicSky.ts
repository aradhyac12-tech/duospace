/**
 * dynamicSky — a continuously time-interpolated gradient, the same idea as
 * Apple's Dynamic wallpaper: instead of flipping between two fixed "light"
 * and "dark" images, the color smoothly drifts through a whole day — deep
 * night blues fading into a dawn glow, a bright midday sky, a warm sunset,
 * and back down into night again. There's no hard cut anywhere; every
 * minute of the day has its own slightly different color.
 *
 * This drives the optional "Dynamic Sky" chat wallpaper. It's visually
 * paired with "dynamic" appearance mode (see themeEngine.ts's
 * deriveDynamicTokens) — selecting Dynamic mode in Settings auto-selects
 * this wallpaper too, so the whole app (chrome + wallpaper) drifts through
 * the day together instead of the wallpaper feeling disconnected from the
 * theme around it.
 */

import type { HSL } from "./themeEngine";

interface SkyKeyframe {
  hour: number; // 0–24, may include fractions (6.5 = 6:30am)
  top: HSL;
  bottom: HSL;
}

const hslStr = (c: HSL): string => `hsl(${Math.round(c.h)} ${Math.round(c.s)}% ${Math.round(c.l)}%)`;

// Keyframes anchor the gradient at key moments of the day. Everything
// between them is smoothly interpolated — this is the whole trick, there
// is no "if hour < 6 use night" branching anywhere.
const SKY_KEYFRAMES: SkyKeyframe[] = [
  { hour: 0,    top: { h: 230, s: 45, l: 8  }, bottom: { h: 220, s: 35, l: 14 } }, // deep night
  { hour: 4.5,  top: { h: 225, s: 50, l: 12 }, bottom: { h: 250, s: 35, l: 20 } }, // pre-dawn
  { hour: 6,    top: { h: 230, s: 40, l: 32 }, bottom: { h: 20,  s: 70, l: 68 } }, // sunrise
  { hour: 8,    top: { h: 200, s: 65, l: 62 }, bottom: { h: 40,  s: 55, l: 85 } }, // morning
  { hour: 12,   top: { h: 205, s: 70, l: 58 }, bottom: { h: 200, s: 40, l: 88 } }, // midday
  { hour: 16,   top: { h: 205, s: 60, l: 56 }, bottom: { h: 42,  s: 55, l: 80 } }, // afternoon
  { hour: 18.5, top: { h: 255, s: 40, l: 28 }, bottom: { h: 12,  s: 80, l: 60 } }, // sunset
  { hour: 20,   top: { h: 242, s: 45, l: 14 }, bottom: { h: 280, s: 35, l: 24 } }, // dusk
  { hour: 24,   top: { h: 230, s: 45, l: 8  }, bottom: { h: 220, s: 35, l: 14 } }, // back to night
];

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// Hue wraps at 360°, so interpolate along the shortest arc rather than
// always going "up" — otherwise e.g. 350° -> 10° would drift the long way
// around through 180° instead of the short 20° hop.
const lerpHue = (a: number, b: number, t: number) => {
  const delta = ((((b - a) % 360) + 540) % 360) - 180;
  return (a + delta * t + 360) % 360;
};

const lerpHsl = (a: HSL, b: HSL, t: number): HSL => ({
  h: lerpHue(a.h, b.h, t),
  s: lerp(a.s, b.s, t),
  l: lerp(a.l, b.l, t),
});

function fractionalHour(date: Date): number {
  return date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
}

function interpolateSky(hour: number): { top: HSL; bottom: HSL } {
  let i = 0;
  while (i < SKY_KEYFRAMES.length - 1 && hour >= SKY_KEYFRAMES[i + 1].hour) i++;
  const a = SKY_KEYFRAMES[i];
  const b = SKY_KEYFRAMES[Math.min(i + 1, SKY_KEYFRAMES.length - 1)];
  const span = b.hour - a.hour;
  const t = span <= 0 ? 0 : (hour - a.hour) / span;
  return { top: lerpHsl(a.top, b.top, t), bottom: lerpHsl(a.bottom, b.bottom, t) };
}

/** A CSS gradient string for the current (or given) moment — smoothly interpolated, never a hard cut. */
export function getSkyGradient(date: Date = new Date()): string {
  const { top, bottom } = interpolateSky(fractionalHour(date));
  return `linear-gradient(180deg, ${hslStr(top)} 0%, ${hslStr(bottom)} 100%)`;
}

/** A short human label for the current time-of-day segment, for UI copy ("Dusk", "Midday", ...). */
export function getSkyPeriodLabel(date: Date = new Date()): string {
  const h = fractionalHour(date);
  if (h < 4.5) return "Night";
  if (h < 6) return "Pre-dawn";
  if (h < 8) return "Sunrise";
  if (h < 11) return "Morning";
  if (h < 15) return "Midday";
  if (h < 18.5) return "Afternoon";
  if (h < 20) return "Sunset";
  return "Night";
}

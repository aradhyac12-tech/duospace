/**
 * Music surface palette — restrained dark wine / graphite, replacing the previous
 * per-section rainbow gradients (violet, emerald, sky, pink, fuchsia…).
 *
 * Decorative SURFACES (headers, tiles, hero) use these fixed tones so the Music section
 * reads as one calm, dark space. Interactive controls (play buttons, active states, progress)
 * keep using the theme's `primary` token, so the user's chosen theme still applies there.
 *
 * Class strings are literal so Tailwind's scanner keeps them.
 */
export const WINE_SURFACE = "bg-gradient-to-br from-[hsl(350_48%_28%)] to-[hsl(350_28%_11%)]";
export const WINE_CHIP = "bg-[hsl(350_48%_28%)] text-white";

const TONES = [
  WINE_SURFACE,
  "bg-gradient-to-br from-[hsl(345_36%_24%)] to-[hsl(345_20%_10%)]",
  "bg-gradient-to-br from-[hsl(220_8%_26%)] to-[hsl(220_8%_10%)]",
  "bg-gradient-to-br from-[hsl(14_40%_25%)] to-[hsl(10_24%_10%)]",
] as const;

/** Stable tone for a key (genre id, mood id…): the same key always gets the same surface. */
export function toneFor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return TONES[h % TONES.length];
}

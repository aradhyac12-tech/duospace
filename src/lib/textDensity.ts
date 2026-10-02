/**
 * textDensity — a preset that controls text/spacing DENSITY, independent of
 * which font family is chosen (that's fontLoader.ts's job). Three CSS vars
 * do all the work:
 *
 *   --text-scale    multiplies the root font-size. Because this app's
 *                    Tailwind config uses the default rem-based scale for
 *                    font sizes, padding, gap, and most icon sizing (e.g.
 *                    h-4/w-4), scaling the root font-size scales ALL of
 *                    those proportionally in one shot — no component-by-
 *                    component changes needed. This is the same mechanism
 *                    browsers use for "Larger Text" accessibility settings.
 *   --leading-boost  multiplies body line-height on top of the scale, so
 *                    "Comfort"/"Readable" can feel airier than a same-size
 *                    preset like "Classic" without changing font size.
 *   --tracking       letter-spacing in em, layered onto the existing
 *                    -0.01em heading tracking already in index.css.
 */

export interface TextDensityPreset {
  id: string;
  name: string;
  description: string;
  scale: number;        // root font-size multiplier
  leadingBoost: number;  // line-height multiplier
  tracking: string;      // letter-spacing, e.g. "0em" | "-0.01em"
}

export const TEXT_DENSITY_PRESETS: TextDensityPreset[] = [
  { id: "classic",  name: "Classic",  description: "Balanced default",        scale: 1.00, leadingBoost: 1.00, tracking: "0em" },
  { id: "modern",   name: "Modern",   description: "Tighter, sharper",         scale: 0.97, leadingBoost: 0.95, tracking: "-0.012em" },
  { id: "comfort",  name: "Comfort",  description: "Airy, relaxed spacing",    scale: 1.05, leadingBoost: 1.18, tracking: "0em" },
  { id: "compact",  name: "Compact",  description: "Dense, fits more",         scale: 0.90, leadingBoost: 0.90, tracking: "-0.006em" },
  { id: "elegant",  name: "Elegant",  description: "Refined, editorial",       scale: 1.00, leadingBoost: 1.10, tracking: "0.012em" },
  { id: "readable", name: "Readable", description: "Maximum clarity",         scale: 1.08, leadingBoost: 1.30, tracking: "0em" },
  { id: "large",    name: "Large",    description: "Bigger text throughout",  scale: 1.20, leadingBoost: 1.20, tracking: "0em" },
];

const LS_KEY = "duo-text-density";

export const applyTextDensity = (id: string) => {
  const preset = TEXT_DENSITY_PRESETS.find(p => p.id === id) ?? TEXT_DENSITY_PRESETS[0];
  const r = document.documentElement.style;
  r.setProperty("--text-scale", String(preset.scale));
  r.setProperty("--leading-boost", String(preset.leadingBoost));
  r.setProperty("--tracking", preset.tracking);
  try { localStorage.setItem(LS_KEY, preset.id); } catch { /* ignore */ }
};

export const getActiveTextDensityId = (): string => {
  try { return localStorage.getItem(LS_KEY) || TEXT_DENSITY_PRESETS[0].id; } catch { return TEXT_DENSITY_PRESETS[0].id; }
};

export const bootTextDensity = () => applyTextDensity(getActiveTextDensityId());

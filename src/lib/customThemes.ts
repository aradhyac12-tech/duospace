// Custom theme storage + runtime overrides.
// Lightweight engine that layers on top of the existing ThemeContext presets.
// Stores per-user custom themes (HSL palette overrides) in localStorage and
// applies them by writing CSS variables to :root, the same way ThemeContext does.

import storage from "@/lib/storage";

export interface CustomTheme {
  id: string;
  name: string;
  primary: string;        // "H S% L%"
  accent: string;         // "H S% L%"
  background?: string;    // optional override "H S% L%"
  foreground?: string;    // optional
  amoled?: boolean;       // forces background to 0 0% 0%
  gradient?: { from: string; to: string } | null; // optional bg gradient
  createdAt: number;
}

const STORAGE_KEY = "duo-custom-themes";
const ACTIVE_KEY  = "duo-custom-theme-active";

export const listCustomThemes = (): CustomTheme[] => {
  try { return JSON.parse(storage.get(STORAGE_KEY) || "[]"); } catch { return []; }
};

export const saveCustomTheme = (t: CustomTheme) => {
  const all = listCustomThemes().filter(x => x.id !== t.id);
  all.unshift(t);
  storage.set(STORAGE_KEY, JSON.stringify(all.slice(0, 50)));
};

export const deleteCustomTheme = (id: string) => {
  const all = listCustomThemes().filter(x => x.id !== id);
  storage.set(STORAGE_KEY, JSON.stringify(all));
  if (storage.get(ACTIVE_KEY) === id) {
    storage.remove(ACTIVE_KEY);
    clearCustomThemeOverride();
  }
};

export const getActiveCustomThemeId = (): string | null => storage.get(ACTIVE_KEY) || null;

const ROOT_VARS = ["--primary", "--accent", "--ring", "--background", "--foreground"];

export const applyCustomTheme = (t: CustomTheme) => {
  const root = document.documentElement;
  root.style.setProperty("--primary", t.primary);
  root.style.setProperty("--ring", t.primary);
  root.style.setProperty("--accent", t.accent);
  if (t.amoled) {
    root.style.setProperty("--background", "0 0% 0%");
    root.style.setProperty("--card", "0 0% 4%");
  } else if (t.background) {
    root.style.setProperty("--background", t.background);
  }
  if (t.foreground) root.style.setProperty("--foreground", t.foreground);

  // Optional gradient via body background
  if (t.gradient) {
    document.body.style.setProperty(
      "background-image",
      `linear-gradient(135deg, hsl(${t.gradient.from}), hsl(${t.gradient.to}))`,
    );
    document.body.style.setProperty("background-attachment", "fixed");
  } else {
    document.body.style.removeProperty("background-image");
    document.body.style.removeProperty("background-attachment");
  }
  storage.set(ACTIVE_KEY, t.id);
};

export const clearCustomThemeOverride = () => {
  const root = document.documentElement;
  ROOT_VARS.forEach(v => root.style.removeProperty(v));
  document.body.style.removeProperty("background-image");
  document.body.style.removeProperty("background-attachment");
  storage.remove(ACTIVE_KEY);
};

export const restoreActiveCustomTheme = () => {
  const id = getActiveCustomThemeId();
  if (!id) return;
  const t = listCustomThemes().find(x => x.id === id);
  if (t) applyCustomTheme(t);
};

// ── Color conversion helpers ────────────────────────────────────────────────

export const hexToHsl = (hex: string): string | null => {
  const m = hex.replace("#", "").match(/^([0-9a-f]{6})$/i);
  if (!m) return null;
  const num = parseInt(m[1], 16);
  const r = ((num >> 16) & 255) / 255;
  const g = ((num >> 8) & 255) / 255;
  const b = (num & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }
  return `${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
};

export const hslToHex = (hsl: string): string => {
  const m = hsl.match(/(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%/);
  if (!m) return "#000000";
  const h = parseFloat(m[1]) / 360, s = parseFloat(m[2]) / 100, l = parseFloat(m[3]) / 100;
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r: number, g: number, b: number;
  if (s === 0) { r = g = b = l; }
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
};

export const exportThemes = (): string => JSON.stringify(listCustomThemes(), null, 2);

export const importThemes = (json: string): number => {
  try {
    const incoming = JSON.parse(json) as CustomTheme[];
    if (!Array.isArray(incoming)) return 0;
    const existing = listCustomThemes();
    const map = new Map(existing.map(t => [t.id, t]));
    let added = 0;
    for (const t of incoming) {
      if (!t.id || !t.primary || !t.accent) continue;
      if (!map.has(t.id)) added++;
      map.set(t.id, t);
    }
    storage.set(STORAGE_KEY, JSON.stringify([...map.values()]));
    return added;
  } catch { return 0; }
};

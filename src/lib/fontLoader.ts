/**
 * fontLoader — dynamically injects Google Fonts and applies CSS variables
 * `--font-heading` / `--font-body`. Called by ThemeStudio + on app boot.
 */

export interface FontPreset {
  id: string;
  name: string;
  heading: string;   // font family
  body: string;
  gfHeading: string; // Google Fonts URL fragment
  gfBody: string;
  category: "serif" | "sans" | "mono" | "display";
}

export const FONT_PRESETS: FontPreset[] = [
  { id: "instrument-dm",    name: "Instrument Serif · DM Sans",  heading: "'Instrument Serif', serif", body: "'DM Sans', sans-serif",
    gfHeading: "Instrument+Serif:ital@0;1", gfBody: "DM+Sans:ital,opsz,wght@0,9..40,100..1000;1,9..40,100..1000", category: "serif" },
  { id: "fraunces-inter",   name: "Fraunces · Inter",            heading: "'Fraunces', serif", body: "'Inter', sans-serif",
    gfHeading: "Fraunces:ital,opsz,wght@0,9..144,300..900;1,9..144,300..900", gfBody: "Inter:wght@300..900", category: "serif" },
  { id: "cormorant-karla",  name: "Cormorant · Karla",           heading: "'Cormorant Garamond', serif", body: "'Karla', sans-serif",
    gfHeading: "Cormorant+Garamond:ital,wght@0,300..700;1,300..700", gfBody: "Karla:wght@300..800", category: "serif" },
  { id: "playfair-manrope", name: "Playfair · Manrope",          heading: "'Playfair Display', serif", body: "'Manrope', sans-serif",
    gfHeading: "Playfair+Display:ital,wght@0,400..900;1,400..900", gfBody: "Manrope:wght@200..800", category: "serif" },
  { id: "newsreader-dm",    name: "Newsreader · DM Sans",        heading: "'Newsreader', serif", body: "'DM Sans', sans-serif",
    gfHeading: "Newsreader:ital,opsz,wght@0,6..72,200..800;1,6..72,200..800", gfBody: "DM+Sans:wght@300..900", category: "serif" },
  { id: "crimson-dm",       name: "Crimson Pro · DM Sans",       heading: "'Crimson Pro', serif", body: "'DM Sans', sans-serif",
    gfHeading: "Crimson+Pro:ital,wght@0,200..900;1,200..900", gfBody: "DM+Sans:wght@300..900", category: "serif" },
  { id: "instrument-geist", name: "Instrument Serif · Geist",    heading: "'Instrument Serif', serif", body: "'Geist', sans-serif",
    gfHeading: "Instrument+Serif:ital@0;1", gfBody: "Geist:wght@100..900", category: "serif" },
  { id: "sora-manrope",     name: "Sora · Manrope",              heading: "'Sora', sans-serif", body: "'Manrope', sans-serif",
    gfHeading: "Sora:wght@200..800", gfBody: "Manrope:wght@200..800", category: "sans" },
  { id: "outfit-figtree",   name: "Outfit · Figtree",            heading: "'Outfit', sans-serif", body: "'Figtree', sans-serif",
    gfHeading: "Outfit:wght@200..900", gfBody: "Figtree:wght@300..900", category: "sans" },
  { id: "space-inter",      name: "Space Grotesk · Inter",       heading: "'Space Grotesk', sans-serif", body: "'Inter', sans-serif",
    gfHeading: "Space+Grotesk:wght@300..700", gfBody: "Inter:wght@300..900", category: "sans" },
  { id: "bricolage-inter",  name: "Bricolage · Inter",           heading: "'Bricolage Grotesque', sans-serif", body: "'Inter', sans-serif",
    gfHeading: "Bricolage+Grotesque:opsz,wght@12..96,200..800", gfBody: "Inter:wght@300..900", category: "display" },
  { id: "urbanist-epilogue",name: "Urbanist · Epilogue",         heading: "'Urbanist', sans-serif", body: "'Epilogue', sans-serif",
    gfHeading: "Urbanist:wght@100..900", gfBody: "Epilogue:wght@100..900", category: "sans" },
  { id: "syne-jakarta",     name: "Syne · Plus Jakarta",         heading: "'Syne', sans-serif", body: "'Plus Jakarta Sans', sans-serif",
    gfHeading: "Syne:wght@400..800", gfBody: "Plus+Jakarta+Sans:wght@200..800", category: "display" },
  { id: "dm-serif-fira",    name: "DM Serif · Fira Sans",        heading: "'DM Serif Display', serif", body: "'Fira Sans', sans-serif",
    gfHeading: "DM+Serif+Display:ital@0;1", gfBody: "Fira+Sans:wght@300..900", category: "serif" },
  { id: "abril-cabin",      name: "Abril Fatface · Cabin",       heading: "'Abril Fatface', serif", body: "'Cabin', sans-serif",
    gfHeading: "Abril+Fatface", gfBody: "Cabin:wght@400..700", category: "display" },
  { id: "bebas-barlow",     name: "Bebas Neue · Barlow",         heading: "'Bebas Neue', sans-serif", body: "'Barlow', sans-serif",
    gfHeading: "Bebas+Neue", gfBody: "Barlow:wght@200..900", category: "display" },
  { id: "jetbrains-work",   name: "JetBrains Mono · Work Sans",  heading: "'JetBrains Mono', monospace", body: "'Work Sans', sans-serif",
    gfHeading: "JetBrains+Mono:wght@200..800", gfBody: "Work+Sans:wght@200..900", category: "mono" },
  { id: "libre-plex",       name: "Libre Baskerville · IBM Plex",heading: "'Libre Baskerville', serif", body: "'IBM Plex Sans', sans-serif",
    gfHeading: "Libre+Baskerville:ital,wght@0,400;0,700;1,400", gfBody: "IBM+Plex+Sans:wght@300..700", category: "serif" },
];

const LS_KEY = "duo-font-preset";
const STYLE_ID = "duo-dyn-font";

const injectStylesheet = (href: string) => {
  let link = document.getElementById(STYLE_ID) as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement("link");
    link.id = STYLE_ID;
    link.rel = "stylesheet";
    document.head.appendChild(link);
  }
  if (link.href !== href) link.href = href;
};

export const applyFontPreset = (id: string) => {
  const preset = FONT_PRESETS.find(p => p.id === id) ?? FONT_PRESETS[0];
  const url = `https://fonts.googleapis.com/css2?family=${preset.gfHeading}&family=${preset.gfBody}&display=swap`;
  injectStylesheet(url);
  const r = document.documentElement.style;
  r.setProperty("--font-heading", preset.heading);
  r.setProperty("--font-body", preset.body);
  try { localStorage.setItem(LS_KEY, preset.id); } catch { /* ignore */ }
};

export const getActiveFontPresetId = (): string => {
  try { return localStorage.getItem(LS_KEY) || FONT_PRESETS[0].id; } catch { return FONT_PRESETS[0].id; }
};

export const bootFontPreset = () => applyFontPreset(getActiveFontPresetId());

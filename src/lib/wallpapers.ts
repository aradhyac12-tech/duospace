/**
 * Chat wallpapers, paired light + dark per design so they auto-adapt to the
 * app's color mode instead of looking mismatched when the user toggles
 * Appearance in Settings/Theme Studio.
 *
 * Storage: `chatWallpaper` (in ThemeContext / localStorage) now stores a
 * wallpaper ID, not a raw CSS string — resolveWallpaperStyle() looks up the
 * right variant for the current mode at render time. Backward-compat: if
 * the stored value isn't a known ID (an old raw CSS string saved before
 * this change), it's returned as-is so existing selections don't break —
 * they just won't auto-adapt until the user picks a wallpaper again.
 */

export interface Wallpaper {
  id: string;
  name: string;
  category: string;
  light: string;
  dark: string;
}

export const WALLPAPERS: Wallpaper[] = [
  { id: "w-minimal", name: "Minimal", category: "Minimal", light: `linear-gradient(180deg, hsl(30,15%,97%) 0%, hsl(30,10%,94%) 100%), url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20width%3D%22180%22%20height%3D%22180%22%3E%3Cfilter%20id%3D%22n%22%3E%3CfeTurbulence%20type%3D%22fractalNoise%22%20baseFrequency%3D%220.9%22%20numOctaves%3D%222%22%20stitchTiles%3D%22stitch%22/%3E%3CfeColorMatrix%20type%3D%22saturate%22%20values%3D%220%22/%3E%3C/filter%3E%3Crect%20width%3D%22100%25%22%20height%3D%22100%25%22%20filter%3D%22url%28%2523n%29%22%20opacity%3D%220.05%22/%3E%3C/svg%3E")`, dark: `linear-gradient(180deg, hsl(230,15%,10%) 0%, hsl(230,12%,7%) 100%), url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20width%3D%22180%22%20height%3D%22180%22%3E%3Cfilter%20id%3D%22n%22%3E%3CfeTurbulence%20type%3D%22fractalNoise%22%20baseFrequency%3D%220.9%22%20numOctaves%3D%222%22%20stitchTiles%3D%22stitch%22/%3E%3CfeColorMatrix%20type%3D%22saturate%22%20values%3D%220%22/%3E%3C/filter%3E%3Crect%20width%3D%22100%25%22%20height%3D%22100%25%22%20filter%3D%22url%28%2523n%29%22%20opacity%3D%220.08%22/%3E%3C/svg%3E")` },
  { id: "w-sunset", name: "Sunset", category: "Soft Gradient", light: `linear-gradient(135deg, hsl(20,70%,90%) 0%, hsl(345,55%,85%) 100%)`, dark: `linear-gradient(135deg, hsl(345,40%,16%) 0%, hsl(20,35%,13%) 100%)` },
  { id: "w-horizon", name: "Horizon", category: "Soft Gradient", light: `linear-gradient(135deg, hsl(200,55%,88%) 0%, hsl(230,45%,80%) 100%)`, dark: `linear-gradient(135deg, hsl(230,40%,14%) 0%, hsl(210,35%,10%) 100%)` },
  { id: "w-mesh", name: "Mesh Bloom", category: "Mesh Gradient", light: `radial-gradient(at 15% 20%, hsl(340,70%,88%) 0%, transparent 55%), radial-gradient(at 85% 10%, hsl(220,65%,86%) 0%, transparent 55%), radial-gradient(at 50% 100%, hsl(160,55%,86%) 0%, transparent 55%), hsl(30,20%,97%)`, dark: `radial-gradient(at 20% 15%, hsl(265,60%,25%) 0%, transparent 55%), radial-gradient(at 85% 20%, hsl(200,55%,22%) 0%, transparent 55%), radial-gradient(at 50% 100%, hsl(320,50%,20%) 0%, transparent 55%), hsl(230,20%,8%)` },
  { id: "w-aurora", name: "Aurora", category: "Aurora", light: `radial-gradient(at 10% 0%, hsl(160,60%,88%) 0%, transparent 45%), radial-gradient(at 90% 10%, hsl(260,55%,90%) 0%, transparent 45%), radial-gradient(at 50% 90%, hsl(200,55%,90%) 0%, transparent 50%), hsl(30,20%,97%)`, dark: `radial-gradient(at 10% 0%, hsl(160,80%,35%) 0%, transparent 45%), radial-gradient(at 90% 10%, hsl(260,80%,40%) 0%, transparent 45%), radial-gradient(at 50% 90%, hsl(200,80%,35%) 0%, transparent 50%), hsl(230,25%,6%)` },
  { id: "w-grain", name: "Grain", category: "Noise", light: `linear-gradient(160deg, hsl(28,30%,92%) 0%, hsl(24,25%,86%) 100%), url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20width%3D%22180%22%20height%3D%22180%22%3E%3Cfilter%20id%3D%22n%22%3E%3CfeTurbulence%20type%3D%22fractalNoise%22%20baseFrequency%3D%220.9%22%20numOctaves%3D%222%22%20stitchTiles%3D%22stitch%22/%3E%3CfeColorMatrix%20type%3D%22saturate%22%20values%3D%220%22/%3E%3C/filter%3E%3Crect%20width%3D%22100%25%22%20height%3D%22100%25%22%20filter%3D%22url%28%2523n%29%22%20opacity%3D%220.05%22/%3E%3C/svg%3E")`, dark: `linear-gradient(160deg, hsl(0,0%,11%) 0%, hsl(0,0%,7%) 100%), url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20width%3D%22180%22%20height%3D%22180%22%3E%3Cfilter%20id%3D%22n%22%3E%3CfeTurbulence%20type%3D%22fractalNoise%22%20baseFrequency%3D%220.9%22%20numOctaves%3D%222%22%20stitchTiles%3D%22stitch%22/%3E%3CfeColorMatrix%20type%3D%22saturate%22%20values%3D%220%22/%3E%3C/filter%3E%3Crect%20width%3D%22100%25%22%20height%3D%22100%25%22%20filter%3D%22url%28%2523n%29%22%20opacity%3D%220.08%22/%3E%3C/svg%3E")` },
  { id: "w-paper", name: "Paper", category: "Paper", light: `linear-gradient(175deg, hsl(38,35%,95%) 0%, hsl(35,28%,90%) 100%), url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20width%3D%22180%22%20height%3D%22180%22%3E%3Cfilter%20id%3D%22n%22%3E%3CfeTurbulence%20type%3D%22fractalNoise%22%20baseFrequency%3D%220.75%22%20numOctaves%3D%223%22%20stitchTiles%3D%22stitch%22/%3E%3CfeColorMatrix%20type%3D%22saturate%22%20values%3D%220%22/%3E%3C/filter%3E%3Crect%20width%3D%22100%25%22%20height%3D%22100%25%22%20filter%3D%22url%28%2523n%29%22%20opacity%3D%220.045%22/%3E%3C/svg%3E")`, dark: `linear-gradient(175deg, hsl(30,8%,14%) 0%, hsl(30,6%,10%) 100%), url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20width%3D%22180%22%20height%3D%22180%22%3E%3Cfilter%20id%3D%22n%22%3E%3CfeTurbulence%20type%3D%22fractalNoise%22%20baseFrequency%3D%220.75%22%20numOctaves%3D%223%22%20stitchTiles%3D%22stitch%22/%3E%3CfeColorMatrix%20type%3D%22saturate%22%20values%3D%220%22/%3E%3C/filter%3E%3Crect%20width%3D%22100%25%22%20height%3D%22100%25%22%20filter%3D%22url%28%2523n%29%22%20opacity%3D%220.06%22/%3E%3C/svg%3E")` },
  { id: "w-dots", name: "Dot Grid", category: "Minimal Shapes", light: `radial-gradient(circle, hsl(30,10%,75%) 1px, transparent 1.2px) 0 0/16px 16px, hsl(30,15%,97%)`, dark: `radial-gradient(circle, hsl(220,10%,30%) 1px, transparent 1.2px) 0 0/16px 16px, hsl(230,15%,9%)` },
  { id: "w-forest", name: "Forest", category: "Nature", light: `linear-gradient(160deg, hsl(150,25%,90%) 0%, hsl(155,20%,78%) 100%)`, dark: `linear-gradient(160deg, hsl(155,30%,10%) 0%, hsl(150,25%,6%) 100%)` },
  { id: "w-ocean", name: "Ocean", category: "Nature", light: `linear-gradient(160deg, hsl(195,50%,90%) 0%, hsl(200,45%,80%) 100%)`, dark: `linear-gradient(160deg, hsl(195,45%,20%) 0%, hsl(210,50%,10%) 100%)` },
];
export function resolveWallpaperStyle(idOrLegacy: string | null, mode: "light" | "dark"): string | null {
  if (!idOrLegacy) return null;
  const wp = WALLPAPERS.find(w => w.id === idOrLegacy);
  if (wp) return mode === "dark" ? wp.dark : wp.light;
  // Legacy raw CSS string from before wallpapers were mode-paired.
  return idOrLegacy;
}

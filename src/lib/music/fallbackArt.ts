/**
 * Generated artwork for any track that has none (or whose image fails to load):
 * a deterministic gradient + the title's first character, as an SVG data URL.
 * Same title+artist always gives the same cover, so a track looks the same
 * everywhere it appears. Pure and synchronous — safe to call during render.
 */
const hash = (s: string): number => { let h = 7; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };
const esc = (c: string) => c.replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m] as string));

const cache = new Map<string, string>();

export function fallbackArt(title?: string | null, artist?: string | null): string {
  const seed = `${title ?? ""}|${artist ?? ""}`;
  const hit = cache.get(seed);
  if (hit) return hit;
  const h = hash(seed) % 360;
  const letter = esc((Array.from((title ?? "").trim())[0] ?? "♪").toUpperCase());
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${h},70%,55%)"/><stop offset="1" stop-color="hsl(${(h + 55) % 360},70%,32%)"/></linearGradient></defs>` +
    `<rect width="200" height="200" fill="url(#g)"/>` +
    `<circle cx="160" cy="40" r="70" fill="#fff" fill-opacity=".08"/>` +
    `<text x="100" y="126" font-family="system-ui,sans-serif" font-size="96" font-weight="700" fill="#fff" fill-opacity=".92" text-anchor="middle">${letter}</text></svg>`;
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  if (cache.size > 500) cache.clear();
  cache.set(seed, url);
  return url;
}

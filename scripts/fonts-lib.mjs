// Pure helpers for scripts/fetch-fonts.mjs (unit-tested; no network, no fs).

/** "Space+Grotesk:wght@300..700" -> "space-grotesk" */
export function familySlug(gfFragment) {
  return gfFragment.split(":")[0].toLowerCase().replace(/\+/g, "-").replace(/[^a-z0-9-]/g, "");
}

/** Pull `id` + both Google-Fonts fragments for every preset out of fontLoader.ts source text. */
export function parsePresets(src) {
  const out = [];
  const re = /id:\s*"([^"]+)"[\s\S]*?gfHeading:\s*"([^"]+)"\s*,\s*gfBody:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(src))) out.push({ id: m[1], gfHeading: m[2], gfBody: m[3] });
  return out;
}

/** Google's css2 response -> [{ subset, block, urls[] }]. Subset comes from the `/* latin *\/` comment. */
export function parseFontFaces(css) {
  const faces = [];
  const re = /\/\*\s*([a-z0-9-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/gi;
  let m;
  while ((m = re.exec(css))) {
    const urls = [...m[2].matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map((u) => u[1]);
    faces.push({ subset: m[1], block: m[2], urls });
  }
  return faces;
}

export const KEEP_SUBSETS = new Set(["latin", "latin-ext"]);

/** Keep only the subsets we ship, so the bundle doesn't carry cyrillic/vietnamese/etc. */
export function pickFaces(faces, keep = KEEP_SUBSETS) {
  return faces.filter((f) => keep.has(f.subset) && f.urls.length > 0);
}

/** Replace each gstatic URL in a block with its local path, via `localFor(url)`. */
export function rewriteBlock(block, localFor) {
  return block.replace(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g, (_, u) => `url(${localFor(u)})`);
}

/** Final safety net used by the build/test: no Google host may remain in generated CSS. */
export function hasRemoteFontHost(css) {
  return /fonts\.(googleapis|gstatic)\.com/.test(css);
}

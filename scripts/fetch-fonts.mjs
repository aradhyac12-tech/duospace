/**
 * One-time (per font change) developer step: self-host the app's fonts.
 *
 *   node scripts/fetch-fonts.mjs        # needs internet, run on YOUR machine
 *
 * Downloads each family's woff2 (latin + latin-ext) from Google Fonts into
 * public/fonts/files and writes public/fonts/base.css (the three families used
 * in index.html) plus one public/fonts/<presetId>.css per theme preset. Commit
 * the result. After this the app never contacts fonts.googleapis.com or
 * fonts.gstatic.com at runtime, so a visitor's IP is not sent to Google
 * (LG München I, 20 Jan 2022, 3 O 17493/20). Re-run only when presets change.
 * Fonts are SIL OFL; keep public/fonts/LICENSES.md with the files.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { familySlug, parsePresets, parseFontFaces, pickFaces, rewriteBlock, hasRemoteFontHost } from "./fonts-lib.mjs";

const OUT = path.resolve("public/fonts");
const FILES = path.join(OUT, "files");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"; // makes Google answer with woff2
const BASE_FRAGMENTS = ["Inter:wght@300..900", "Space+Grotesk:wght@300..700", "JetBrains+Mono:wght@400;500"];

const cache = new Map(); // gstatic url -> local file name
async function download(url) {
  if (cache.has(url)) return cache.get(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const name = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 16) + ".woff2";
  fs.writeFileSync(path.join(FILES, name), buf);
  cache.set(url, name);
  return name;
}

async function cssFor(fragments) {
  const q = fragments.map((f) => `family=${f}`).join("&");
  const res = await fetch(`https://fonts.googleapis.com/css2?${q}&display=swap`, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`css2 ${res.status} for ${q}`);
  const faces = pickFaces(parseFontFaces(await res.text()));
  const blocks = [];
  for (const f of faces) {
    const local = new Map();
    for (const u of f.urls) local.set(u, `/fonts/files/${await download(u)}`);
    blocks.push(`/* ${f.subset} */\n${rewriteBlock(f.block, (u) => local.get(u))}`);
  }
  if (!blocks.length) throw new Error(`no latin faces for ${q}`);
  return blocks.join("\n");
}

fs.mkdirSync(FILES, { recursive: true });
const presets = parsePresets(fs.readFileSync("src/lib/fontLoader.ts", "utf8"));
if (!presets.length) throw new Error("could not parse presets from src/lib/fontLoader.ts");

const jobs = [{ file: "base.css", fragments: BASE_FRAGMENTS }, ...presets.map((p) => ({ file: `${p.id}.css`, fragments: [...new Set([p.gfHeading, p.gfBody])] }))];
for (const j of jobs) {
  const css = await cssFor(j.fragments);
  if (hasRemoteFontHost(css)) throw new Error(`${j.file} still references a Google host`);
  fs.writeFileSync(path.join(OUT, j.file), css + "\n");
  console.log("wrote", j.file, `(${j.fragments.map(familySlug).join(", ")})`);
}
fs.writeFileSync(path.join(OUT, "LICENSES.md"), "# Font licenses\n\nAll fonts here are served from Google Fonts under the SIL Open Font License 1.1 (https://openfontlicense.org) or Apache 2.0 where stated by the family's page. Keep this notice with the files.\n");
console.log(`done: ${cache.size} font files, ${jobs.length} css files in public/fonts`);

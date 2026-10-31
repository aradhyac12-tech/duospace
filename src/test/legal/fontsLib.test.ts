import { describe, expect, it } from "vitest";
import { familySlug, hasRemoteFontHost, parseFontFaces, parsePresets, pickFaces, rewriteBlock } from "../../../scripts/fonts-lib.mjs";

const CSS = `/* cyrillic */
@font-face { font-family: 'Inter'; src: url(https://fonts.gstatic.com/s/inter/v1/cyr.woff2) format('woff2'); }
/* latin */
@font-face { font-family: 'Inter'; src: url(https://fonts.gstatic.com/s/inter/v1/lat.woff2) format('woff2'); }
/* latin-ext */
@font-face { font-family: 'Inter'; src: url(https://fonts.gstatic.com/s/inter/v1/ext.woff2) format('woff2'); }`;

describe("fonts-lib", () => {
  it("slugs families", () => {
    expect(familySlug("Space+Grotesk:wght@300..700")).toBe("space-grotesk");
    expect(familySlug("Abril+Fatface")).toBe("abril-fatface");
  });
  it("keeps only latin subsets and rewrites every remote url", () => {
    const faces = pickFaces(parseFontFaces(CSS));
    expect(faces.map((f: { subset: string }) => f.subset)).toEqual(["latin", "latin-ext"]);
    const out = rewriteBlock(faces[0].block, (u: string) => `/fonts/files/${u.split("/").pop()}`);
    expect(out).toContain("url(/fonts/files/lat.woff2)");
    expect(hasRemoteFontHost(out)).toBe(false);
    expect(hasRemoteFontHost(CSS)).toBe(true);
  });
  it("parses every preset out of fontLoader.ts", async () => {
    const fs = await import("node:fs");
    const presets = parsePresets(fs.readFileSync("src/lib/fontLoader.ts", "utf8"));
    expect(presets.length).toBeGreaterThanOrEqual(18);
    expect(presets[0]).toEqual({ id: "space-inter", gfHeading: "Space+Grotesk:wght@300..700", gfBody: "Inter:wght@300..900" });
  });
});

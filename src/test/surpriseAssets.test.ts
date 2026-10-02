/**
 * Tests for src/lib/surpriseAssets.ts — the editor-side folding of large
 * base64 data: URIs into short ds-asset:// tokens (and back).
 */
import { describe, it, expect } from "vitest";
import { COLLAPSE_MIN_CHARS, collapseAssets, expandAssets, orphanedTokens } from "@/lib/surpriseAssets";

const bigUri = (fill: string) => `data:image/png;base64,${fill.repeat(COLLAPSE_MIN_CHARS + 50)}`;

describe("collapseAssets / expandAssets", () => {
  it("folds big data URIs into tokens and round-trips losslessly", () => {
    const a = bigUri("A");
    const b = bigUri("B");
    const parts = {
      html: `<img src="${a}"><audio src="${b}"></audio>`,
      css: `.x{background:url("${a}")}`,
      js: `new Audio("${b}")`,
    };
    const c = collapseAssets(parts);
    expect(c.html).toBe('<img src="ds-asset://a1"><audio src="ds-asset://a2"></audio>');
    expect(c.css).toBe('.x{background:url("ds-asset://a1")}'); // same bytes → same token
    expect(c.js).toBe('new Audio("ds-asset://a2")');
    expect(Object.keys(c.table)).toHaveLength(2);

    const back = expandAssets({ html: c.html, css: c.css, js: c.js }, c.table);
    expect(back).toEqual(parts);
  });

  it("leaves small data URIs and non-base64 data URIs readable", () => {
    const small = "data:image/png;base64,iVBORw0KGgo=";
    const svg = "data:image/svg+xml,%3Csvg%3E%3C/svg%3E";
    const parts = { html: `<img src="${small}"><img src="${svg}">`, css: "", js: "" };
    const c = collapseAssets(parts);
    expect(c.html).toBe(parts.html);
    expect(c.table).toEqual({});
  });

  it("expand only touches tokens it has bytes for", () => {
    const out = expandAssets({ html: "ds-asset://a1 ds-asset://a9", css: "", js: "" }, { a1: "X" });
    expect(out.html).toBe("X ds-asset://a9");
  });
});

describe("orphanedTokens", () => {
  it("reports tokens with no backing bytes (e.g. pasted from another surprise)", () => {
    const orphans = orphanedTokens({ html: '<img src="ds-asset://a1"><img src="ds-asset://a7">', css: "", js: "" }, { a1: "X" });
    expect(orphans).toEqual(["ds-asset://a7"]);
  });
});

// Regression guard for the privacy checklist: nothing in the shipped shell may
// make a visitor's browser contact Google Fonts, and no session-replay /
// third-party analytics SDK may creep into the dependency list.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(p, "utf8");
const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(css|ts|tsx|html)$/.test(e.name)) out.push(full);
  }
  return out;
};

describe("no third-party font/analytics loads", () => {
  it("index.html and the font loader never reference Google Fonts hosts", () => {
    // og:image/twitter:image are fetched by social crawlers, not by visitors' browsers.
    const html = read("index.html").replace(/<meta[^>]+(og:image|twitter:image)[^>]*>/g, "");
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    expect(read("src/lib/fontLoader.ts")).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
  });

  it("no source or css file pulls fonts from Google at runtime", () => {
    const offenders = walk("src").filter((f) => !f.includes(`${path.sep}test${path.sep}`) && /fonts\.(googleapis|gstatic)\.com/.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it("no session-replay or third-party analytics dependency", () => {
    const pkg = JSON.parse(read("package.json"));
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const banned = /(posthog|hotjar|fullstory|logrocket|rrweb|clarity|smartlook|mouseflow|heap|mixpanel|amplitude|segment|google-analytics|react-ga|gtag)/i;
    expect(names.filter((n) => banned.test(n))).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Source-level guards for the web cold-boot path. They do NOT prove first-frame behaviour
// on a device; native splash colour (capacitor.config.json) needs a physical-device check.
const root = resolve(__dirname, "../..");
const html = readFileSync(resolve(root, "index.html"), "utf8");
const main = readFileSync(resolve(root, "src/main.tsx"), "utf8");

describe("theme cold boot (source)", () => {
  it("index.html applies the saved theme in an inline script before the app module", () => {
    const inline = html.indexOf('getItem("duo-theme-mode")');
    const mod = html.indexOf('type="module"');
    expect(inline).toBeGreaterThan(-1);
    expect(mod).toBeGreaterThan(inline);
    expect(html).toContain("duo-boot-tokens");
  });
  it("main.tsx calls bootTheme() before the first React render", () => {
    expect(main.indexOf("bootTheme()")).toBeGreaterThan(-1);
    expect(main.indexOf("bootTheme()")).toBeLessThan(main.indexOf("createRoot(document.getElementById"));
  });
});

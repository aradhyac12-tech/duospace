import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const css = read("src/index.css");
const tw = read("tailwind.config.ts");

/** Body of the first top-level `selector { ... }` block that DEFINES the given token. */
const blockDefining = (selector: string, token: string): string => {
  const re = new RegExp(`(^|\\n)\\s*${selector.replace(".", "\\.")}\\s*\\{`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    let depth = 0, i = css.indexOf("{", m.index);
    const start = i;
    for (; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) break;
    }
    const body = css.slice(start, i);
    if (body.includes(`${token}:`)) return body;
  }
  return "";
};

describe("call theme tokens (theme-engine hooks + fallbacks)", () => {
  it("keeps the theme-engine's call-stage tokens defined for light and dark", () => {
    for (const sel of [":root", ".dark"]) {
      expect(blockDefining(sel, "--call-stage")).not.toBe("");
      expect(blockDefining(sel, "--call-stage-foreground")).not.toBe("");
    }
  });
  it("defines the wine accent for light and dark", () => {
    expect(blockDefining(":root", "--call-accent")).not.toBe("");
    expect(blockDefining(".dark", "--call-accent")).not.toBe("");
    expect(blockDefining(":root", "--call-accent-foreground")).not.toBe("");
  });
  it("derives control surfaces from the theme's call-stage tokens so custom themes carry through", () => {
    expect(css).toMatch(/--call-ctrl:\s*var\(--call-stage-foreground\)/);
    expect(css).toMatch(/--call-ctrl-active:\s*var\(--call-stage-foreground\)/);
    expect(css).toMatch(/--call-ctrl-active-foreground:\s*var\(--call-stage\)/);
  });
  it("still lists the call-stage tokens as theme-overridable", () => {
    const custom = read("src/lib/customThemes.ts");
    expect(custom).toContain('"--call-stage", "--call-stage-foreground"');
  });
  it("exposes the new colours to Tailwind", () => {
    expect(tw).toContain('"call-accent"');
    expect(tw).toContain('"call-ctrl"');
    expect(tw).toContain("var(--call-ctrl-active-foreground)");
  });
});

describe("call motion + timer stability", () => {
  it("ambient ring is compositor-only and disabled under reduced motion", () => {
    const kf = css.slice(css.indexOf("@keyframes call-ring"), css.indexOf(".call-ring {"));
    expect(kf).toMatch(/transform/);
    expect(kf).toMatch(/opacity/);
    expect(kf).not.toMatch(/blur|box-shadow|width|height|top|left/);
    const rm = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    expect(rm).toMatch(/\.call-ring\s*\{[^}]*animation:\s*none/);
  });
  it("timers use tabular numerals so they don't shift layout", () => {
    expect(css).toMatch(/\.call-num\s*\{\s*font-variant-numeric:\s*tabular-nums/);
    expect(read("src/components/calls/CallStage.tsx")).toMatch(/call-num[^"`]*"[^>]*>\s*\{callUiState === "reconnecting"/);
    expect(read("src/components/calls/MinimizedCallBubble.tsx")).toMatch(/call-num[^>]*>\{formatDuration\(callDuration\)\}/);
  });
  it("call surfaces add no static backdrop blur", () => {
    for (const f of ["src/components/calls/CallStage.tsx", "src/components/calls/MinimizedCallBubble.tsx"]) {
      const code = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code).not.toMatch(/backdrop-blur|glass-sheet|glass-dock/);
    }
  });
});

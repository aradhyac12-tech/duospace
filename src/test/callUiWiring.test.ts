import { describe, it, expect } from "vitest";
import ts from "typescript";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Static action-wiring contract: for every labelled control, the onClick still reaches the original handler.
 *  (Static by design — rendering CallStage needs the whole call provider stack.) */
function controls(rel: string): { label: string; onClick: string }[] {
  const src = readFileSync(join(process.cwd(), rel), "utf8");
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const out: { label: string; onClick: string }[] = [];
  const walk = (n: ts.Node) => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const at = new Map<string, string>();
      n.attributes.properties.forEach((p) => {
        if (ts.isJsxAttribute(p) && p.initializer) at.set(p.name.getText(), p.initializer.getText());
      });
      if (at.has("aria-label") && at.has("onClick")) out.push({ label: at.get("aria-label")!, onClick: at.get("onClick")!.replace(/\s+/g, " ") });
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}
const find = (list: ReturnType<typeof controls>, re: RegExp) => list.filter((c) => re.test(c.label));

describe("CallStage controls reach their original handlers", () => {
  const c = controls("src/components/calls/CallStage.tsx");
  it.each([
    [/Minimize call/, /setIsCallMinimized\(true\)/],
    [/(Mute|Unmute) microphone/, /toggleAudio\(\)/],
    [/Turn (on|off) speaker/, /toggleSpeaker/],
    [/Turn (on|off) camera/, /toggleVideo\(\)/],
    [/End call/, /handleEnd/],
    [/Switch to the other camera/, /handleFlipCamera\(\)/],
    [/(Enable|Disable) lip reading/, /setShowLipReading/],
  ])("%s", (label, handler) => {
    const hits = find(c, label);
    expect(hits.length).toBeGreaterThan(0);
    hits.forEach((h) => expect(h.onClick).toMatch(handler));
  });
});

describe("IncomingCallOverlay answer/decline wiring (full screen and slim banner)", () => {
  const c = controls("src/components/IncomingCallOverlay.tsx");
  it("decline buttons call handleDecline", () => {
    const hits = find(c, /Decline/);
    expect(hits.length).toBe(2);
    hits.forEach((h) => expect(h.onClick).toBe("{handleDecline}"));
  });
  it("accept buttons call handleAccept", () => {
    const hits = find(c, /(Accept|Answer)/);
    expect(hits.length).toBe(2);
    hits.forEach((h) => expect(h.onClick).toBe("{handleAccept}"));
  });
});

describe("MinimizedCallBubble wiring", () => {
  const c = controls("src/components/calls/MinimizedCallBubble.tsx");
  it("expand and end go to the original handlers", () => {
    find(c, /Expand call/).forEach((h) => expect(h.onClick).toMatch(/expand\(\)/));
    const ends = find(c, /End call/);
    expect(ends.length).toBe(2); // video bubble + voice pill
    ends.forEach((h) => expect(h.onClick).toMatch(/handleEnd\(\)/));
  });
});

describe("Speaker route picker is actually rendered", () => {
  const src = readFileSync(join(process.cwd(), "src/components/calls/CallStage.tsx"), "utf8");
  it("showRoutePicker has a render site with an accessible dialog and a Cancel path", () => {
    expect(src).toMatch(/showRoutePicker && audioRoute\.supported/);
    expect(src).toContain('aria-label="Audio output"');
    expect(src).toMatch(/audioRoute\.setRoute\(r\)/);
    expect(src).toMatch(/setShowRoutePicker\(false\)/);
  });
});

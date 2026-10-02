/**
 * Phase 3K regression: Phase 3J relationship UI strings must go through tr().
 * Guards (a) the canonical keys resolve to the original English wording and
 * (b) the original literals do not reappear hard-coded in the three components.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tr } from "@/lib/i18n";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const EXPECTED: Record<string, string> = {
  "p1.ai.allowOnDevice": "Allow on-device help",
  "p1.today.consentBody": "DuoSpace can point out one thing worth noticing from today's messages — on your phone only.",
  "p1.today.dismiss": "Dismiss",
  "p1.understand.title": "Understand",
  "p1.understand.consentBody": "DuoSpace can point out what this message says, right here on your phone. Nothing is sent or saved.",
  "p1.understand.repairPrompt": "Need help repairing this?",
  "p1.understand.repair.own": "Own my part",
  "p1.understand.repair.explain": "Explain",
  "p1.understand.repair.boundary": "Set a boundary",
  "p1.understand.repair.walk": "Walk me through it",
  "p1.understand.footer": "Only what the message says — DuoSpace can't know what they feel.",
  "p1.reply.preparing": "Preparing a reply",
  "p1.reply.consentBody": "DuoSpace can suggest a reply right here on your phone. The message isn't sent anywhere, and nothing is saved.",
  "p1.reply.error": "Couldn't suggest a reply right now.",
  "p1.reply.use": "Use this reply",
  "p1.reply.footer": "Based only on their words above — DuoSpace can't know what they feel. You can edit it before sending.",
  "p1.reply.askDirect": "Asking them directly might be best here.",
  "p1.reply.chip.another": "Another",
  "p1.reply.chip.shorter": "Shorter",
  "p1.reply.chip.askFirst": "Ask first",
  "p1.reply.chip.moreCasual": "More casual",
};

describe("Phase 3J relationship UI i18n", () => {
  it("every canonical key resolves to the original English wording", () => {
    for (const [k, v] of Object.entries(EXPECTED)) expect(tr(k, {}, "en"), k).toBe(v);
  });

  it("unreviewed languages fall back to English (never blank, never the key)", () => {
    for (const k of Object.keys(EXPECTED)) expect(tr(k, {}, "hi"), k).toBe(EXPECTED[k]);
  });

  it("the three components do not hard-code the migrated strings", () => {
    const files = [
      "src/components/relationship/TodayInsight.tsx",
      "src/components/chat/UnderstandSheet.tsx",
      "src/components/chat/QuickReplySheet.tsx",
    ].map((p) => [p, read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")] as const);
    for (const [p, src] of files) {
      for (const literal of Object.values(EXPECTED)) {
        // "Help me reply" / "Explain" style short words can legitimately appear inside identifiers or
        // comments; only flag them when they sit as JSX text or a quoted attribute/string.
        const asJsx = new RegExp(`>\\s*${literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*<`);
        const asQuoted = new RegExp(`"${literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`);
        expect(asJsx.test(src) || asQuoted.test(src), `${p} still hard-codes: ${literal}`).toBe(false);
      }
    }
  });
});

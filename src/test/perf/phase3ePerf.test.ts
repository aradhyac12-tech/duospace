import { it } from "vitest";
import { writeFileSync } from "node:fs";
import { supportResponse } from "@/lib/relationship/responsiveness";
import { prepareRepair, newSession, checkSafety } from "@/lib/relationship/repair";
import * as mem from "@/lib/relationship/memory";
import { detectLanguage, multilingualSafetyCategories } from "@/lib/relationship/i18n/lang";

const q = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return { p50: +s[Math.floor(s.length * 0.5)].toFixed(3), p95: +s[Math.floor(s.length * 0.95)].toFixed(3) }; };
async function bench(n: number, f: () => unknown) { const xs: number[] = []; for (let i = 0; i < n; i++) { const t = performance.now(); await f(); xs.push(performance.now() - t); } return q(xs); }

it("Phase 3E sandbox performance (Node.js, not a phone)", async () => {
  let st = mem.emptyMemoryState();
  for (let i = 0; i < 200; i++) st = mem.createMemory(st, { ownerUserId: "A", relationshipId: null, category: "PREFERENCE", topic: "planning", statement: `m${i}`, sourceType: "USER_ENTERED", sourceId: `s${i}`, sourceTimestamp: "2026-09-25" }, { nowMs: Date.now(), newId: () => `m${i}`, consentStore: true }).state;
  const a = { concreteEvent: "You cancelled dinner again, so clearly I'm not important to you.", myResponsibility: "I didn't explain", specificChange: "tell me earlier" };
  const res = {
    environment: `sandbox Node.js ${process.version}; runs=300 each. NOT a phone.`,
    responseSupportEN: await bench(300, () => supportResponse({ partnerMessage: "You didn't call me after work.", myExperience: "I was busy" }, { nowMs: 0 })),
    responseSupportHindiLimited: await bench(300, () => supportResponse({ partnerMessage: "तुमने कल फ़ोन नहीं किया" }, { nowMs: 0, language: "hi" })),
    repairFlowReview: await bench(300, () => prepareRepair({ ...newSession({ id: "r", conflictId: "c", userId: "u", relationshipId: null, nowMs: 0 }), answers: a, stage: "REVIEW", safetyState: checkSafety(a) }, { nowMs: 0 })),
    memorySummary200Records: await bench(300, () => mem.buildLongitudinalSummary(st, [], { me: "A", partner: "B", consents: { store: true, useInAI: true, share: true, longitudinal: true }, nowMs: Date.now() })),
    safetyAndLanguageDetectionPerMessage: await bench(300, () => { detectLanguage("woh mujhe maarta hai aur dhamki deta hai"); multilingualSafetyCategories("woh mujhe maarta hai aur dhamki deta hai"); }),
    notMeasured: ["app startup", "Chat opening", "message send", "call connection", "local-model AI response", "device memory"],
  };
  writeFileSync("docs/eval/phase3e_perf.json", JSON.stringify(res, null, 2) + "\n");
});

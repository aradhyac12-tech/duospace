import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { guardOutput } from "../../../supabase/functions/_shared/ai/guard";
import { ctx, UNDERSTAND_OK } from "../ai/cloud/helpers";
import { computeCompatibility } from "@/lib/relationship/compatibility/engine";
import type { DyadicComparison } from "@/lib/relationship/dyadic/types";
import { nextAdaptiveStep, MIN_DIMENSIONS_COVERED, MAX_QUESTIONS_PER_SESSION, type AdaptiveState } from "@/lib/relationship/compatibility/adaptive";
import { ALL_VALUE_CATEGORIES, type ValueCategory } from "@/lib/relationship/types";

const load = (f: string) => JSON.parse(readFileSync(join(process.cwd(), "docs/ai-eval", f), "utf8"));

describe("ai-eval: banned claims", () => {
  const fx = load("banned_claims.json");
  for (const c of fx.reject) it(`guard rejects [${c.lang}] ${c.text}`, () => {
    expect(guardOutput("UNDERSTAND", { ...UNDERSTAND_OK, summary: c.text }, ctx({ currentText: "I'm tired tonight. Can we talk tomorrow instead? maybe 4 pm" })).ok).toBe(false);
  });
});

describe("ai-eval: explanation preserves deterministic state", () => {
  const fx = load("explain_state_preservation.json");
  const c = ctx({ dimensions: fx.dimensions.map((d: { dimension: string; state: string }) => ({ ...d, userEvidence: null, partnerEvidence: null, alignmentReason: null, differenceReason: null, confidence: "MEDIUM", uncertainty: null, importance: "UNKNOWN", lastUpdated: null, nextBestQuestion: null })) as never, basis: fx.basis });
  for (const a of fx.accept) it(`accepts: ${a.headline}`, () => { expect(guardOutput("COMPATIBILITY_EXPLAIN", a, c).ok).toBe(true); });
  for (const r of fx.reject) it(`rejects: ${r.why}`, () => {
    const { why, ...out } = r;
    expect(guardOutput("COMPATIBILITY_EXPLAIN", out, c).ok).toBe(false);
  });
});

describe("ai-eval: deterministic compatibility states", () => {
  const fx = load("compatibility_states.json");
  for (const cs of fx.cases) it(cs.id, () => {
    const comps = cs.comparisons.map((x: { category: string; status: string; unknownReason?: string }, i: number) =>
      ({ key: `${x.category}-${i}`, kind: "VALUE_ANSWER", category: x.category, prompt: null, status: x.status, unknownReason: x.unknownReason ?? null, self: null, partner: null }) as unknown as DyadicComparison);
    const r = computeCompatibility(comps);
    for (const [k, v] of Object.entries(cs.expect)) {
      if (k === "basis") expect(r.basis).toBe(v);
      else if (k === "clearestDifference") expect(r.clearestDifference).toBe(v);
      else if (k === "allStates") expect(r.dimensions.every((d) => d.state === v)).toBe(true);
      else expect(r.dimensions.find((d) => d.category === k)!.state).toBe(v);
    }
  });
});

describe("ai-eval: adaptive stopping", () => {
  const fx = load("adaptive_stopping.json");
  it("fixture limits match the code constants", () => {
    expect(fx.limits.MIN_DIMENSIONS_COVERED).toBe(MIN_DIMENSIONS_COVERED);
    expect(fx.limits.MAX_QUESTIONS_PER_SESSION).toBe(MAX_QUESTIONS_PER_SESSION);
  });
  for (const c of fx.cases) it(c.id, () => {
    const r = nextAdaptiveStep({ answered: c.answered, asked: c.asked, questionsThisSession: c.questionsThisSession } as AdaptiveState);
    expect(r.decision).toBe(c.expect.decision);
    if (r.decision === "ASK") {
      expect(r.category).toBe(c.expect.category);
      if (c.expect.unknownCount !== undefined) expect(r.unknownCategories.length).toBe(c.expect.unknownCount);
      expect(c.asked).not.toContain(r.category);
      expect(c.answered).not.toContain(r.category);
    } else {
      expect(r.reason).toBe(c.expect.reason);
    }
  });
  for (const sim of fx.simulations) it(`simulation: ${sim.id}`, () => {
    const answered: ValueCategory[] = []; const asked: ValueCategory[] = []; let n = 0; let end = "";
    for (let guard = 0; guard < 40; guard++) {
      const r = nextAdaptiveStep({ answered, asked, questionsThisSession: n });
      if (r.decision === "ENOUGH_INFORMATION") { end = r.reason; break; }
      expect(asked).not.toContain(r.category); // never asks the same dimension twice
      asked.push(r.category); n++;
      if (sim.behaviour === "answered") answered.push(r.category);
    }
    expect(n).toBeLessThanOrEqual(sim.expect.maxQuestions);
    expect(end).toBe(sim.expect.endsWith);
    expect(new Set(asked).size).toBe(asked.length);
    expect(asked.every((c) => (ALL_VALUE_CATEGORIES as readonly string[]).includes(c))).toBe(true);
  });
});

describe("ai-eval: grounding (scripted model output, not a live model)", () => {
  const fx = load("grounding.json");
  const c = ctx(fx.context);
  const und = (o: { evidence: string[]; cannotTell: boolean }) => ({ ...UNDERSTAND_OK, evidence: o.evidence, cannotTell: o.cannotTell });
  for (const a of fx.understand.accept) it(`UNDERSTAND accepts: ${a.id}`, () => { expect(guardOutput("UNDERSTAND", und(a), c).ok).toBe(true); });
  for (const r of fx.understand.reject) it(`UNDERSTAND rejects: ${r.id}`, () => {
    const g = guardOutput("UNDERSTAND", und(r), c);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.category).toBe(r.expectCategory);
  });
  for (const a of fx.numbers.accept) it(`numbers accept: ${a.id}`, () => { expect(guardOutput("UNDERSTAND", { ...UNDERSTAND_OK, summary: a.summary }, c).ok).toBe(true); });
  for (const r of fx.numbers.reject) it(`numbers reject: ${r.id}`, () => {
    const g = guardOutput("UNDERSTAND", { ...UNDERSTAND_OK, summary: r.summary }, c);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.category).toBe(r.expectCategory);
  });
  for (const a of fx.memory.accept) it(`MEMORY_SUGGESTION accepts: ${a.id}`, () => { expect(guardOutput("MEMORY_SUGGESTION", a.value, c).ok).toBe(true); });
  for (const r of fx.memory.reject) it(`MEMORY_SUGGESTION rejects: ${r.id}`, () => {
    const g = guardOutput("MEMORY_SUGGESTION", r.value, c);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.category).toBe(r.expectCategory);
  });
  it("FACT_EXTRACTION drops ungrounded / inferred drafts instead of failing", () => {
    const facts = fx.facts.drafts.map((d: { id: string; exactEvidence: string; isExplicit: boolean; value: string }) =>
      ({ category: "other", subject: "USER", value: d.value, exactEvidence: d.exactEvidence, isExplicit: d.isExplicit, hedged: false, language: UNDERSTAND_OK.language, _id: d.id }));
    const g = guardOutput("FACT_EXTRACTION", { facts }, c);
    expect(g.ok).toBe(true);
    if (g.ok) {
      expect(g.value.facts.map((f: { _id: string }) => f._id)).toEqual(fx.facts.expectKept);
      expect(g.dropped).toBe(fx.facts.expectDropped);
    }
  });
  it("FACT_EXTRACTION: a HARD_BANNED draft value fails the whole call (not just that draft)", () => {
    const b = fx.facts.bannedValueDraft;
    const f = { category: "other", subject: "USER", value: b.value, exactEvidence: b.exactEvidence, isExplicit: b.isExplicit, hedged: false, language: UNDERSTAND_OK.language };
    const g = guardOutput("FACT_EXTRACTION", { facts: [f] }, c);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.category).toBe(b.expectCategory);
  });
});

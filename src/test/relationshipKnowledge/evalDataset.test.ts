/**
 * Runs the versioned SYNTHETIC evaluation dataset (docs/ai-eval/knowledge/) through the engine.
 * Expectations were declared independently of the engine (scripts/generate-knowledge-eval.mjs).
 * Passing proves behavioural consistency with written policy — NOT scientific validity.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { NOW, UA, UB, DYAD, SNAP, obs, run, dim } from "./fixtures";
import {
  normalizeText, assessSafety, confirmDraft, draftToObservation, explainAll, parseAiExtraction, validateAiOutput, resolveFact, dyadicView, STATEMENTS, SAFETY_RANK,
  type Observation,
} from "../../lib/relationship/knowledge/index";

const data = JSON.parse(readFileSync("docs/ai-eval/knowledge/eval-2026.10.0.json", "utf8"));
const MIN: Record<string, number> = { basic: 50, adversarial: 50, multilingual: 30, temporal: 30, contradictory: 30, dyadic: 30, safety: 30 };

function toObs(t: any[]): Observation {
  const [by, about, c, k, v, kindRaw, age, recon] = t;
  let kind = kindRaw ?? undefined; let status: Observation["confirmationStatus"] | null = null;
  if (kind === "partner_disputed") { kind = "partner"; status = "disputed"; }
  if (kind === "self_confirmed") { kind = "self"; status = "confirmed"; }
  if (kind === "self_withdrawn") { kind = "self"; status = "withdrawn"; }
  const o = obs({ by, about, c, k, v, kind, age: age ?? undefined, reconfirmedAge: recon ?? undefined }); // JSON turns undefined into null
  return status ? { ...o, confirmationStatus: status } : o;
}
const SAFETY_OK: Record<string, (s: number) => boolean> = {
  none: (s) => s === 0, possible: (s) => s === 1, reported: (s) => s === 2, confirmed: (s) => s === 3, urgent: (s) => s === 4,
  possible_or_higher: (s) => s >= 1, reported_or_higher: (s) => s >= 2,
};
const ctx = { relationshipId: DYAD.relationshipId, writerUserId: UA, partnerUserId: UB, now: NOW, idFactory: (() => { let i = 0; return () => `e-${++i}`; })() };

describe("evaluation dataset", () => {
  it("meets the required size per group and is synthetic", () => {
    expect(data.synthetic).toBe(true);
    for (const [g, n] of Object.entries(MIN)) expect(data.counts[g]).toBeGreaterThanOrEqual(n);
    expect(new Set(data.cases.map((c: any) => c.id)).size).toBe(data.cases.length);
    for (const c of data.cases) { expect(!!c.expected).toBe(true); expect(Array.isArray(c.forbidden)).toBe(true); }
  });

  for (const c of data.cases) {
    it(`${c.id} ${c.input}`.slice(0, 150), () => {
      const e = c.expected;
      // ── AI guard cases
      if (c.aiExtraction) { const r = parseAiExtraction(JSON.stringify(c.aiExtraction)); expect(r.items).toHaveLength(0); expect(r.rejected.length).toBeGreaterThan(0); return; }
      if (c.aiOutput) { expect(validateAiOutput(c.aiOutput, STATEMENTS["comm.rhythm.different"].statement).ok).toBe(false); return; }

      // ── text cases
      if (c.text !== undefined) {
        const n = normalizeText(c.text);
        const sa = assessSafety(n.safetySignals, NOW);
        expect(SAFETY_OK[e.safety](SAFETY_RANK[sa.state])).toBe(true);
        if (e.state === "safety_review") { expect(sa.suppressOrdinaryAdvice).toBe(true); return; }
        if (e.state === "inferred_unconfirmed") {
          if (c.expectLang) expect(n.detectedLanguage).toBe(c.expectLang);
          const get = (k: string) => n.semantics.find((s) => s.attributeKey === k);
          if ("wants_space" in e) expect(get("wants_space")?.value).toBe(e.wants_space);
          if ("breakup_intent_explicit" in e) { if (e.breakup_intent_explicit === null) expect(get("breakup_intent_explicit")).toBeUndefined(); else expect(get("breakup_intent_explicit")?.value).toBe(e.breakup_intent_explicit); }
          if ("feels_understood" in e) expect(get("feels_understood")?.value).toBe(e.feels_understood);
          expect(n.needsConfirmation).toBe(true);
          for (const s of n.semantics) { const o = draftToObservation(s, ctx); expect(o.sourceType).toBe("inferred"); expect(o.evidenceTier).toBe("inferred"); }
          return;
        }
        if (e.state === "safety_none") return; // benign: the only claim is that no safety concern is raised
        // adversarial / benign text through the whole pipeline
        const out = run(n.semantics.map((s) => confirmDraft(s, ctx)), { stage: c.stage });
        const text = explainAll(out, SNAP, NOW).map((x) => `${x.statement} ${STATEMENTS[x.statement] ?? ""}`).join(" ").toLowerCase();
        for (const f of c.forbidden) expect(text.includes(f.toLowerCase())).toBe(false);
        if (e.dimension) { expect(dim(out, e.dimension).state).toBe(e.state); if (e.confidence) expect(dim(out, e.dimension).confidence).toBe(e.confidence); }
        else if (e.state === "no_verdict") expect(explainAll(out, SNAP, NOW)).toHaveLength(0);
        expect(SAFETY_OK[e.safety](SAFETY_RANK[out.safety.state])).toBe(true);
        return;
      }

      // ── structured observation cases
      const list = (c.observations ?? []).map(toObs);
      const out = run(list, { stage: c.stage });
      expect(SAFETY_OK[e.safety](SAFETY_RANK[out.safety.state])).toBe(true);
      if (e.state === "safety_review") {
        expect(out.safety.suppressOrdinaryAdvice).toBe(true);
        if (e.suppressed) expect(dim(out, e.suppressed).suppressedBecause).toBe("safety_override");
        const t = explainAll(out, SNAP, NOW).map((x) => x.statement).join(" ").toLowerCase();
        for (const f of c.forbidden) expect(t.includes(f.toLowerCase())).toBe(false);
        return;
      }
      if (e.state === "no_verdict") { expect(explainAll(out, SNAP, NOW)).toHaveLength(0); return; }
      const d = dim(out, e.dimension);
      expect(d.state).toBe(e.state);
      expect(d.confidence).toBe(e.confidence);
      if (e.statementKey) expect(d.statementKeys).toEqual([e.statementKey]);
      if (e.perspective) expect(d.perspective).toBe(e.perspective);
      if (e.tierB) expect(resolveFact(list, "B", DYAD, "communication_preferences", "rhythm", NOW).tier).toBe(e.tierB);
      if (e.discrepancyOnB) expect(dyadicView(list, DYAD, "communication_preferences", "rhythm", NOW).discrepancies).toHaveLength(1);
      if (e.historyKept) expect(resolveFact(list, "A", DYAD, "communication_preferences", "rhythm", NOW).observationIds.length).toBe(1);
      const texts = explainAll(out, SNAP, NOW).map((x) => x.statement).join(" ").toLowerCase() + ` ${d.state} ${d.confidence}`;
      for (const f of c.forbidden) expect(texts.includes(f.toLowerCase())).toBe(false);
    });
  }
});

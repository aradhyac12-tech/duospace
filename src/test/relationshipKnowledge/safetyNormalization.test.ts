import { describe, it, expect } from "vitest";
import { NOW, UA, UB, DYAD, SNAP, obs, run, dim, RHYTHM } from "./fixtures";
import {
  assessSafety, normalizeText, draftToObservation, confirmDraft, parseAiExtraction, validateAiOutput, renderStatement, buildAiInput, buildExtractionPrompt,
  isForbiddenAttribute, nextQuestion, gapReport, QUESTION_BANK, explainAll, STATEMENTS, type AiLanguageProvider,
} from "../../lib/relationship/knowledge/index";

const ctx = { relationshipId: DYAD.relationshipId, writerUserId: UA, partnerUserId: UB, now: NOW, idFactory: (() => { let i = 0; return () => `n-${++i}`; })() };

describe("safety override", () => {
  const sig = (indicator: any, o: any = {}) => ({ indicator, firstPerson: true, confirmedByReporter: false, fromText: false, ...o });
  it("no indicators → none", () => expect(assessSafety([]).state).toBe("none"));
  it("single weak indicator → possible only (no automatic diagnosis)", () => expect(assessSafety([sig("monitoring_phone")]).state).toBe("possible_safety_concern"));
  it("indicators not in first person never exceed 'possible'", () => expect(assessSafety([sig("physical_violence", { firstPerson: false })]).state).toBe("possible_safety_concern"));
  it("two distinct coercive-control indicators → reported", () => expect(assessSafety([sig("monitoring_phone"), sig("anger_at_friend_contact")]).state).toBe("reported_safety_concern"));
  it("strong first-person indicator → reported; reporter confirmation → confirmed", () => {
    expect(assessSafety([sig("physical_violence")]).state).toBe("reported_safety_concern");
    expect(assessSafety([sig("physical_violence", { confirmedByReporter: true })]).state).toBe("confirmed_safety_concern");
  });
  it("imminent danger → urgent", () => expect(assessSafety([sig("imminent_danger")]).state).toBe("urgent_safety_concern"));
  it("never allows joint confrontation or sharing with the partner", () => {
    for (const s of [assessSafety([sig("monitoring_phone")]), assessSafety([sig("imminent_danger")])]) { expect(s.jointConfrontationAllowed).toBe(false); expect(s.shareWithPartner).toBe(false); expect(s.suppressOrdinaryAdvice).toBe(true); }
  });
  it("safety outranks ordinary reasoning: communication insight is withheld", () => {
    const list = [RHYTHM("A", "frequent_short"), RHYTHM("B", "infrequent_long"),
      obs({ by: "A", about: "A", c: "coercive_control", k: "monitoring_phone", v: true }), obs({ by: "A", about: "A", c: "coercive_control", k: "isolation", v: true })];
    const out = run(list);
    expect(out.safety.state).toBe("reported_safety_concern");
    expect(dim(out, "communication").suppressedBecause).toBe("safety_override");
    expect(dim(out, "communication").state).toBe("unknown");
    expect(explainAll(out, SNAP, NOW).map((e) => e.statement)).toEqual([STATEMENTS["safety.review"].statement]);
  });
  it("old safety evidence does not decay into 'none'", () => {
    const out = run([obs({ by: "A", about: "A", c: "coercive_control", k: "physical_violence", v: true, age: 2000 })]);
    expect(out.safety.state).not.toBe("none");
  });
  it("a reporter withdrawing a statement is respected", () => {
    const w = { ...obs({ by: "A", about: "A", c: "coercive_control", k: "monitoring_phone", v: true }), confirmationStatus: "withdrawn" as const };
    expect(run([w]).safety.state).toBe("none");
  });
  it("adversarial: 'He checks my phone and gets angry if I talk to friends' → safety review, not communication advice", () => {
    const n = normalizeText("He checks my phone and gets angry if I talk to friends.");
    const a = assessSafety(n.safetySignals);
    expect(["reported_safety_concern", "confirmed_safety_concern", "urgent_safety_concern"]).toContain(a.state);
    expect(a.suppressOrdinaryAdvice).toBe(true);
  });
  it("benign text does not trigger safety", () => {
    expect(assessSafety(normalizeText("I need some space this weekend, work is busy.").safetySignals).state).toBe("none");
  });
});

describe("question engine", () => {
  const base = { asker: "A" as const, dyad: DYAD, stage: "committed" as const, now: NOW, snapshot: SNAP };
  it("asks only when an executable rule would use the answer (A missing, B known → rhythm question)", () => {
    const q = nextQuestion({ ...base, observations: [RHYTHM("B", "frequent_short")] });
    expect(q?.question.id).toBe("q.comm.rhythm"); expect(q?.gap).toBe("missing");
  });
  it("does not ask what is already known", () => {
    const q = nextQuestion({ ...base, observations: [RHYTHM("A", "frequent_short")], recentQuestionIds: [] });
    expect(q?.question.id).not.toBe("q.comm.rhythm");
  });
  it("asks again when the answer is stale", () => {
    const q = nextQuestion({ ...base, observations: [RHYTHM("A", "frequent_short", { age: 250 }), RHYTHM("B", "frequent_short")] });
    expect(q?.question.id).toBe("q.comm.rhythm"); expect(q?.gap).toBe("stale");
  });
  it("at most one question a day (fatigue), recent questions not repeated", () => {
    expect(nextQuestion({ ...base, observations: [], questionsToday: 1 })).toBeNull();
    const q = nextQuestion({ ...base, observations: [RHYTHM("B", "frequent_short")], recentQuestionIds: ["q.comm.rhythm"] });
    expect(q?.question.id).not.toBe("q.comm.rhythm");
  });
  it("never asks while a safety concern is active", () => {
    expect(nextQuestion({ ...base, observations: [RHYTHM("B", "frequent_short")], safetyState: "possible_safety_concern" })).toBeNull();
  });
  it("respects stage and declined constructs", () => {
    expect(nextQuestion({ ...base, stage: "crush", observations: [], declinedConstructs: ["communication_preferences", "capitalization"] })).toBeNull();
  });
  it("nothing is asked when no rule is executable (production snapshot)", () => {
    expect(nextQuestion({ ...base, snapshot: { ...SNAP, rules: SNAP.rules.map((r) => ({ ...r, status: "under_review" as const })) }, observations: [] })).toBeNull();
  });
  it("questions are natural, single, non-survey", () => {
    for (const q of QUESTION_BANK) { expect(q.text).not.toMatch(/rate|1-10|scale|score/i); expect(q.text.split("?").length - 1).toBe(1); }
    expect(gapReport({ ...base, observations: [] }).missing.length).toBeGreaterThan(0);
  });
});

describe("multilingual semantic normalization", () => {
  const find = (n: ReturnType<typeof normalizeText>, key: string) => n.semantics.find((s) => s.attributeKey === key);
  it("Romanized Marathi: 'mala thoda space pahije pan breakup nahi karaycha'", () => {
    const n = normalizeText("mala thoda space pahije pan breakup nahi karaycha");
    expect(n.detectedLanguage).toBe("mr-latn"); expect(n.script).toBe("latin");
    expect(find(n, "wants_space")?.value).toBe(true);
    expect(find(n, "breakup_intent_explicit")?.value).toBe(false);
    expect(n.needsConfirmation).toBe(true);
    expect(n.semantics.some((s) => String(s.value).includes("does_not_want_breakup"))).toBe(false);
  });
  it("Romanized Hindi / Hinglish", () => {
    const n = normalizeText("mujhe thoda space chahiye lekin breakup nahi chahiye");
    expect(n.detectedLanguage).toBe("hinglish");
    expect(find(n, "wants_space")?.value).toBe(true); expect(find(n, "breakup_intent_explicit")?.value).toBe(false);
  });
  it("Devanagari Hindi", () => {
    const n = normalizeText("मुझे थोड़ा स्पेस चाहिए लेकिन ब्रेकअप नहीं");
    expect(n.script).toBe("devanagari"); expect(n.detectedLanguage).toBe("hi");
    expect(find(n, "wants_space")?.value).toBe(true); expect(find(n, "breakup_intent_explicit")?.value).toBe(false);
  });
  it("Devanagari Marathi", () => {
    const n = normalizeText("मला थोडी जागा हवी आहे पण ब्रेकअप नको");
    expect(n.detectedLanguage).toBe("mr"); expect(find(n, "wants_space")?.value).toBe(true); expect(find(n, "breakup_intent_explicit")?.value).toBe(false);
  });
  it("English: 'I need some space' is about the writer; 'She wants some space' is about the partner", () => {
    expect(find(normalizeText("I need some space."), "wants_space")?.about).toBe("self");
    const p = find(normalizeText("She wants some space."), "wants_space");
    expect(p?.value).toBe(true); expect(p?.about).toBe("partner");
    const o = confirmDraft(p!, ctx);
    expect(o.sourceType).toBe("partner_report"); expect(o.subjectUserId).toBe(UB); // a report about her, not her own statement
  });
  it("everything extracted is INFERRED; only the writer's confirmation makes it explicit", () => {
    const n = normalizeText("mala thoda space pahije");
    const o = draftToObservation(n.semantics[0], ctx);
    expect(o.sourceType).toBe("inferred"); expect(o.evidenceTier).toBe("inferred"); expect(o.explicitness).toBe("implicit");
    const c = confirmDraft(n.semantics[0], ctx);
    expect(c.sourceType).toBe("self_report"); expect(c.evidenceTier).toBe("explicit_self_report");
    expect(c.observationId).not.toBe(o.observationId); // a NEW observation; history kept
  });
  it("a statement about the partner can only ever become a partner report, never the partner's own", () => {
    const n = normalizeText("She replies late.");
    expect(n.semantics[0].about).toBe("partner");
    const c = confirmDraft(n.semantics[0], ctx);
    expect(c.sourceType).toBe("partner_report"); expect(c.subjectUserId).toBe(UB); expect(c.evidenceTier).toBe("unconfirmed_partner_report");
  });
  it("mind-reading attributes are rejected", () => {
    for (const k of ["love", "cheating", "narcissism", "avoidant_attachment", "manipulation", "loss_of_interest", "breakup_intention"]) expect(isForbiddenAttribute(k)).toBe(true);
    expect(() => draftToObservation({ constructId: "trust", attributeKey: "cheating", value: true, about: "partner", pattern: "x" }, ctx)).toThrow();
  });
  it("pipeline: 'wants space' + 'no breakup' never yields a breakup or distance conclusion", () => {
    const n = normalizeText("mala thoda space pahije pan breakup nahi karaycha");
    const list = n.semantics.map((s) => draftToObservation(s, ctx));
    const out = run(list);
    const d = dim(out, "relationship_direction");
    expect(d.state).toBe("insufficient_evidence"); expect(d.confidence).toBe("low");
    const text = explainAll(out, SNAP, NOW).map((e) => e.statement).join(" ");
    expect(text).not.toMatch(/break|leave|distance|care|love|interest/i);
  });
});

describe("AI is subordinate (hallucination, causality, mind-reading prevention)", () => {
  const result = dim(run([RHYTHM("A", "frequent_short"), RHYTHM("B", "infrequent_long")]), "communication");
  const approved = STATEMENTS["comm.rhythm.different"].statement;
  const bad = (text: string): AiLanguageProvider => ({ rephrase: async () => text });
  it("accepts a faithful rephrase", () => expect(validateAiOutput("Your chat rhythms seem to differ.", approved).ok).toBe(true));
  for (const [label, text] of [
    ["mind-reading", "He doesn't really care about talking to you."], ["emotional distance", "He seems emotionally distant."], ["loss of interest", "She is losing interest."],
    ["breakup prediction", "This will probably lead to a breakup."], ["causality", "Your rhythms differ because he is avoidant."], ["attachment label", "Their attachment style is avoidant."],
    ["false precision", "You are 72% compatible."], ["compatibility", "You may be incompatible."], ["authority claim", "Studies show these rhythms cause conflict."],
    ["diagnosis", "This looks like a depressive disorder."], ["cheating", "He may be cheating."], ["url", "See https://example.com"],
  ] as const) it(`rejects ${label}`, () => expect(validateAiOutput(text, approved).ok).toBe(false));
  it("falls back to the approved template on a violation, never shows the AI text", async () => {
    const r = await renderStatement(result, "comm.rhythm.different", bad("He doesn't care about you."));
    expect(r.source).toBe("template"); expect(r.text).toBe(approved); expect(r.fallbackReason).toMatch(/banned/);
  });
  it("falls back when the provider throws, and works without a provider", async () => {
    expect((await renderStatement(result, "comm.rhythm.different", { rephrase: async () => { throw new Error("x"); } })).source).toBe("template");
    expect((await renderStatement(result, "comm.rhythm.different", null)).text).toBe(approved);
  });
  it("uses AI wording only when it passes validation", async () => {
    const r = await renderStatement(result, "comm.rhythm.different", bad("You two seem to have different chat rhythms."));
    expect(r.source).toBe("ai");
  });
  it("AI input is minimised: no ids, no raw text, no user names", () => {
    const s = JSON.stringify(buildAiInput(result, "comm.rhythm.different"));
    expect(s).not.toContain(UA); expect(s).not.toContain("obs-"); expect(s).toContain("frequent_short");
    expect(Object.keys(buildAiInput(result, "comm.rhythm.different")).sort()).toEqual(["approvedStatement", "confidence", "dimension", "evidence", "state"]);
  });
  it("extraction prompt is bounded and instructs against interpretation", () => {
    const p = buildExtractionPrompt("x".repeat(5000), ["communication_preferences"]);
    expect(p.user.length).toBeLessThanOrEqual(600); expect(p.system).toMatch(/Do not interpret/);
  });
  it("extraction parser rejects invented constructs and forbidden attributes (LLM cannot add taxonomy)", () => {
    const r = parseAiExtraction(JSON.stringify([
      { construct: "emotional_intelligence_score", attribute: "x", value: 1, about: "self" },
      { construct: "trust", attribute: "cheating", value: true, about: "partner" },
      { construct: "communication_preferences", attribute: "rhythm", value: "frequent_short", about: "self" }]));
    expect(r.items).toHaveLength(1); expect(r.rejected).toHaveLength(2);
    expect(r.items[0].pattern).toBe("ai_extraction");
    expect(parseAiExtraction("not json").items).toHaveLength(0);
  });
  it("AI cannot change engine state: result objects are produced before and independent of the provider", async () => {
    const before = JSON.stringify(result); await renderStatement(result, "comm.rhythm.different", bad("anything")); expect(JSON.stringify(result)).toBe(before);
  });
});

describe("adversarial inputs", () => {
  const texts = ["He replies late.", "She wants some space.", "He doesn't text much but is attentive in person."];
  it("never produces mind-reading statements", () => {
    for (const t of texts) {
      const n = normalizeText(t);
      const ctx2 = { ...ctx, idFactory: (() => { let i = 100; return () => `a-${++i}`; })() };
      const out = run(n.semantics.map((s) => confirmDraft(s, ctx2)));
      const all = explainAll(out, SNAP, NOW).map((e) => e.statement + " " + (STATEMENTS[""] ?? "")).join(" ");
      expect(all).not.toMatch(/care|love|interest|distant|break|leav|incompat|cheat/i);
    }
  });
  it("'He replies late' is recorded as a behaviour report about the partner, nothing more", () => {
    const n = normalizeText("He replies late.");
    expect(n.semantics.map((s) => `${s.constructId}.${s.attributeKey}=${s.value}`)).toEqual(["digital_communication.reply_latency=slow"]);
  });
  it("'attentive in person' alongside low texting → positive responsiveness evidence (low confidence), no negative verdict", () => {
    const n = normalizeText("He doesn't text much but is attentive in person.");
    const out = run(n.semantics.map((s) => confirmDraft(s, ctx)));
    expect(dim(out, "responsiveness").state).toBe("positive_evidence"); expect(dim(out, "responsiveness").confidence).toBe("low");
  });
});

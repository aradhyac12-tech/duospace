import { describe, it, expect } from "vitest";
import { guardOutput } from "../../../../supabase/functions/_shared/ai/guard";
import { ctx, UNDERSTAND_OK } from "./helpers";

const U = ctx({ currentText: "I'm tired tonight. Can we talk tomorrow instead? maybe 4 pm" });
const lang = { code: "en", script: "latin", codeMixed: false };
const reply = (text: string) => ({ suggestions: [{ text, mode: "normal", respondsTo: "talk tomorrow" }], insufficientContext: false });

describe("output guard — banned claims", () => {
  const bad = [
    "They are 87% compatible with you.", "Compatibility score is high.", "This looks like a 9/10 match.", "You two are incompatible.",
    "They will break up soon.", "This relationship won't last.", "They are probably cheating.", "They are lying to you.",
    "They show signs of narcissism.", "That is toxic behaviour.", "This suggests an anxious attachment style.", "Perfect match!", "They are soulmates.",
  ];
  for (const s of bad) it(`rejects: ${s}`, () => {
    const r = guardOutput("UNDERSTAND", { ...UNDERSTAND_OK, summary: s }, U);
    expect(r.ok).toBe(false);
  });
  it("rejects mind-reading on interpretive tasks", () => {
    for (const s of ["They secretly want space from you.", "Deep down she really feels hurt.", "He is afraid of commitment.", "She is obviously upset with you."])
      expect(guardOutput("UNDERSTAND", { ...UNDERSTAND_OK, summary: s }, U).ok).toBe(false);
  });
  it("rejects prompt-leak text", () => { expect(guardOutput("UNDERSTAND", { ...UNDERSTAND_OK, summary: "My system prompt says hi." }, U).ok).toBe(false); });
  it("accepts a grounded, attributed understanding", () => { expect(guardOutput("UNDERSTAND", UNDERSTAND_OK, U).ok).toBe(true); });
});

describe("output guard — grounding", () => {
  it("rejects invented quotes", () => { expect(guardOutput("UNDERSTAND", { ...UNDERSTAND_OK, evidence: ["I hate you"] }, U)).toMatchObject({ ok: false, category: "UNGROUNDED_EVIDENCE" }); });
  it("requires evidence unless cannotTell", () => {
    expect(guardOutput("UNDERSTAND", { ...UNDERSTAND_OK, evidence: [] }, U).ok).toBe(false);
    expect(guardOutput("UNDERSTAND", { ...UNDERSTAND_OK, evidence: [], cannotTell: true }, U).ok).toBe(true);
  });
  it("quote matching ignores case/whitespace but not content", () => {
    expect(guardOutput("UNDERSTAND", { ...UNDERSTAND_OK, evidence: ["TALK   tomorrow"] }, U).ok).toBe(true);
  });
  it("rejects numbers not present in the supplied text", () => {
    expect(guardOutput("UNDERSTAND", { ...UNDERSTAND_OK, summary: "They want to talk at 9." }, U)).toMatchObject({ ok: false, category: "UNSUPPORTED_NUMBER" });
    expect(guardOutput("UNDERSTAND", { ...UNDERSTAND_OK, summary: "They suggest 4 pm tomorrow." }, U).ok).toBe(true);
  });
  it("works for Devanagari evidence", () => {
    const c = ctx({ currentText: "आज मैं बहुत थक गई हूँ, कल बात करें?" });
    expect(guardOutput("UNDERSTAND", { ...UNDERSTAND_OK, summary: "वह कल बात करना चाहती है।", evidence: ["कल बात करें"] }, c).ok).toBe(true);
    expect(guardOutput("UNDERSTAND", { ...UNDERSTAND_OK, evidence: ["कल नहीं"] }, c).ok).toBe(false);
  });
});

describe("output guard — replies", () => {
  it("rejects coercive / accusing replies", () => {
    for (const t of ["You always do this.", "If you really loved me you'd call.", "Call me or else.", "You owe me an answer."]) expect(guardOutput("QUICK_REPLY", reply(t), U).ok).toBe(false);
  });
  it("accepts a calm reply", () => { expect(guardOutput("QUICK_REPLY", reply("Sure, let's talk tomorrow. Rest well tonight."), U).ok).toBe(true); });
  it("rejects empty result that does not admit insufficient context", () => {
    expect(guardOutput("QUICK_REPLY", { suggestions: [], insufficientContext: false }, U).ok).toBe(false);
    expect(guardOutput("QUICK_REPLY", { suggestions: [], insufficientContext: true }, U).ok).toBe(true);
  });
});

describe("output guard — facts", () => {
  const draft = (over = {}) => ({ category: "relationship_duration", subject: "USER", value: "8 months together", exactEvidence: "together for eight months", isExplicit: true, hedged: false, language: lang, ...over });
  const C = ctx({ currentText: "We've been together for eight months." });
  it("keeps explicit grounded facts", () => {
    const r = guardOutput("FACT_EXTRACTION", { facts: [draft()] }, C);
    expect(r).toMatchObject({ ok: true, dropped: 0 });
  });
  it("drops inferred facts (AI inference never becomes a strong fact)", () => {
    const r = guardOutput("FACT_EXTRACTION", { facts: [draft({ value: "highly committed", isExplicit: false })] }, C);
    expect(r).toMatchObject({ ok: true, dropped: 1 });
    expect((r as { value: { facts: unknown[] } }).value.facts).toHaveLength(0);
  });
  it("drops facts whose evidence is not in the text", () => {
    expect((guardOutput("FACT_EXTRACTION", { facts: [draft({ exactEvidence: "engaged for two years" })] }, C) as { dropped: number }).dropped).toBe(1);
  });
});

describe("output guard — compatibility consistency with the deterministic result", () => {
  const dim = (dimension: string, state: string) => ({ dimension, state, userEvidence: null, partnerEvidence: null, alignmentReason: null, differenceReason: null, confidence: "MEDIUM", uncertainty: null, importance: "UNKNOWN", lastUpdated: null, nextBestQuestion: null });
  const C = ctx({ basis: "BOTH_PARTNERS", dimensions: [dim("communication", "ALIGNED"), dim("pace", "DIFFERENT"), dim("conflict", "DISCOVERING"), dim("finances", "INSUFFICIENT_DATA")] as never });
  const out = (o = {}) => ({ headline: "You align on communication; pace differs.", clearestDifference: "pace", stillDiscovering: ["conflict", "finances"], suggestedDiscussion: null, basis: "BOTH_PARTNERS", ...o });
  it("accepts an output consistent with the engine", () => { expect(guardOutput("COMPATIBILITY_EXPLAIN", out(), C).ok).toBe(true); });
  it("rejects naming an ALIGNED dimension as the difference", () => { expect(guardOutput("COMPATIBILITY_EXPLAIN", out({ clearestDifference: "communication" }), C)).toMatchObject({ ok: false, category: "SEMANTIC_MISMATCH" }); });
  it("rejects listing a DIFFERENT/ALIGNED dimension as still discovering", () => { expect(guardOutput("COMPATIBILITY_EXPLAIN", out({ stillDiscovering: ["pace"] }), C).ok).toBe(false); });
  it("rejects a changed basis (one-sided result presented as dyadic)", () => {
    const one = ctx({ ...C, basis: "ONE_PARTNER" });
    expect(guardOutput("COMPATIBILITY_DEEP", out(), one).ok).toBe(false);
  });
  it("rejects 'incompatible' wording even when the structure is right", () => { expect(guardOutput("COMPATIBILITY_EXPLAIN", out({ headline: "You are incompatible on pace." }), C).ok).toBe(false); });
});

describe("output guard — other tasks", () => {
  it("TODAY: no insight is valid; text without insight is not", () => {
    expect(guardOutput("TODAY", { hasInsight: false, kind: "NONE", text: null }, ctx()).ok).toBe(true);
    expect(guardOutput("TODAY", { hasInsight: false, kind: "NONE", text: "Something!" }, ctx()).ok).toBe(false);
    expect(guardOutput("TODAY", { hasInsight: true, kind: "CLARIFY", text: null }, ctx()).ok).toBe(false);
  });
  it("ADAPTIVE_QUESTION: may only ask an unknown, not-yet-asked dimension", () => {
    const c = ctx({ unknownDimensions: ["conflict", "pace"], askedDimensions: ["pace"] });
    expect(guardOutput("ADAPTIVE_QUESTION", { decision: "ASK", dimension: "conflict", text: "When you're upset, do you prefer to talk or take space?" }, c).ok).toBe(true);
    expect(guardOutput("ADAPTIVE_QUESTION", { decision: "ASK", dimension: "pace", text: "q?" }, c).ok).toBe(false);
    expect(guardOutput("ADAPTIVE_QUESTION", { decision: "ASK", dimension: "finances", text: "q?" }, c).ok).toBe(false);
    expect(guardOutput("ADAPTIVE_QUESTION", { decision: "ENOUGH_INFORMATION", dimension: null, text: null }, c).ok).toBe(true);
  });
  it("MEMORY_SUGGESTION: needs grounded evidence", () => {
    const c = ctx({ currentText: "I prefer a call rather than texting when I'm upset." });
    expect(guardOutput("MEMORY_SUGGESTION", { shouldSuggest: true, text: "Prefers a call when upset", category: "PREFERENCE", evidence: "prefer a call rather than texting", sensitive: false }, c).ok).toBe(true);
    expect(guardOutput("MEMORY_SUGGESTION", { shouldSuggest: true, text: "Hates texting", category: "PREFERENCE", evidence: "hate texting", sensitive: false }, c).ok).toBe(false);
  });
});

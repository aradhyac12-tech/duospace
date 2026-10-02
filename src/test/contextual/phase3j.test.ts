import { describe, it, expect } from "vitest";
import { extractFacts } from "@/lib/relationship/contextual/extract";
import { understand } from "@/lib/relationship/contextual/present";
import { analyzeMessage } from "@/lib/relationship/responsiveness";

const ex = (t: string) => extractFacts({ id: "m", text: t });
const spansHold = (t: string) => {
  const e = ex(t);
  for (const f of e.facts) {
    expect(t.slice(f.span[0], f.span[1]), `${t} :: ${f.kind}`).toBe(f.phrase);
    if (f.detailSpan) expect(t.slice(f.detailSpan[0], f.detailSpan[1])).toBe(f.detail);
  }
  return e;
};

describe("span invariant: sourceText.slice(start, end) === text", () => {
  const corpus = [
    "Can we talk tonight? I felt ignored.", "You don't care about me.", "You're obviously angry.", "Why did you do that?",
    "Can you call me tonight?", "Call me when you're free.", "Fine.", "Whatever.", "Maybe.", "", "   ", "  Can you   call me?  ",
    "I just wanted you to ask how my day was!!", "You never tell me when you're going to be late.", "I'm sorry. I hear you. Can you stay?",
    "tum ne kal phone kyun nahi kiya?", "तुमने कल फ़ोन क्यों नहीं किया?", "Please don't go through my phone.",
  ];
  for (const t of corpus) it(JSON.stringify(t), () => { spansHold(t); });
});

describe("required examples", () => {
  it("'Can we talk tonight? I felt ignored.' → independent QUESTION and FEELING spans", () => {
    const e = spansHold("Can we talk tonight? I felt ignored.");
    expect(e.facts.find((f) => f.kind === "QUESTION")?.phrase).toBe("Can we talk tonight?");
    expect(e.facts.find((f) => f.kind === "FEELING")?.phrase).toBe("I felt ignored");
    expect(e.facts.find((f) => f.kind === "REQUEST")?.rule).toBe("future-we");
  });
  it("'You don't care about me.' is an accusation span, never evidence that they don't care", () => {
    const e = ex("You don't care about me.");
    expect(e.facts.map((f) => f.kind)).toContain("ACCUSATION");
    expect(e.facts.some((f) => f.kind === "FEELING")).toBe(false);
    const u = understand({ id: "x", text: "You don't care about me." });
    expect(u.statement.replace(/“[^”]*”/g, "")).not.toMatch(/doesn'?t care|don'?t care|not care/i);
  });
  it("'You're obviously angry.' → no feeling fact; nothing claims anyone is angry", () => {
    const e = ex("You're obviously angry.");
    expect(e.facts.some((f) => f.kind === "FEELING")).toBe(false);
    expect(understand({ id: "x", text: "You're obviously angry." }).statement.replace(/“[^”]*”/g, "")).not.toMatch(/angry/i);
  });
  it("'Why did you do that?' → question", () => expect(ex("Why did you do that?").primaryIntent).toBe("QUESTION"));
  it("'Can you call me tonight?' → request about contact", () => {
    const e = ex("Can you call me tonight?");
    expect(e.primaryIntent).toBe("REQUEST");
    expect(e.domain).toBe("CONTACT");
  });
  it("'Call me when you're free.' — imperative without a request marker is not covered by the existing rules → no invented request", () => {
    const e = ex("Call me when you're free.");
    expect(e.facts.some((f) => f.kind === "REQUEST")).toBe(false);
    expect(e.primaryIntent).toBe("UNKNOWN");
  });
  for (const t of ["Fine.", "Whatever.", "Maybe."]) {
    it(`'${t}' → ambiguous, UNKNOWN, honest can't-tell`, () => {
      const e = ex(t);
      expect(e.ambiguous).toBe(true);
      expect(e.primaryIntent).toBe("UNKNOWN");
      expect(understand({ id: "x", text: t }).statement).toMatch(/can't reliably tell/i);
    });
  }
});

describe("canonical result fields", () => {
  it("primaryIntent priority: REQUEST > QUESTION > EXPRESSION > ACKNOWLEDGEMENT > UNKNOWN", () => {
    expect(ex("I felt sad. Why did you go? Can you call me?").primaryIntent).toBe("REQUEST");
    expect(ex("I felt sad. Why did you go?").primaryIntent).toBe("QUESTION");
    expect(ex("I felt sad about today.").primaryIntent).toBe("EXPRESSION");
    expect(ex("I hear you, that makes sense.").primaryIntent).toBe("ACKNOWLEDGEMENT");
    expect(ex("The weather was nice today at the park.").primaryIntent).toBe("UNKNOWN");
  });
  it("PAST_EXPECTATION and CONTROL are observable spans", () => {
    expect(ex("You didn't call me after work.").facts.map((f) => f.kind)).toContain("PAST_EXPECTATION");
    expect(ex("Give me your password so I can check your phone.").facts.map((f) => f.kind)).toContain("CONTROL");
  });
  it("safety-sensitive text is flagged (handled before any presentation)", () => {
    expect(ex("He threatened to hurt me if I leave.").safetySignals.length).toBeGreaterThan(0);
    expect(ex("usne mujhe dhamki di").safetySignals.length).toBeGreaterThan(0);
  });
  it("empty/whitespace → nothing extracted", () => {
    for (const t of ["", "   "]) expect(ex(t)).toMatchObject({ facts: [], primaryIntent: "UNKNOWN", domain: null });
  });
});

describe("one semantic source: the responsiveness engine reads the canonical extraction", () => {
  it("domain and ambiguity in analyzeMessage equal the extractor's", () => {
    for (const t of ["You didn't call me after work.", "Fine.", "Can you help with the dishes?", "I need some time to myself tonight.", "My parents expected us on Sunday."]) {
      const a = analyzeMessage(t), e = extractFacts({ id: "analyze", text: t.replace(/\s+/g, " ").trim().slice(0, 400) }, { englishRules: true });
      expect(a.ambiguous, t).toBe(e.ambiguous);
      expect((a.domain as { id?: string } | null)?.id ?? null, t).toBe(e.domain);
    }
  });
});

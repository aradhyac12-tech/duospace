import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import {
  newSession, transition, checkSafety, prepareRepair, splitFactFromInterpretation, organize, validateRepairComponent,
  type RepairAnswers, type RepairSession, type RepairRephraser,
} from "@/lib/relationship/repair";

const NOW = Date.parse("2026-09-25T12:00:00Z");
const S = (answers: RepairAnswers = {}, stage: RepairSession["stage"] = "REVIEW"): RepairSession =>
  ({ ...newSession({ id: "r1", conflictId: "c1", userId: "u", relationshipId: "rel", nowMs: NOW }), answers, stage, safetyState: checkSafety(answers) });
const prep = (a: RepairAnswers, o: Partial<Parameters<typeof prepareRepair>[1]> = {}) => prepareRepair(S(a), { nowMs: NOW, ...o });
const blob = (x: unknown) => JSON.stringify(x);

describe("A. state machine", () => {
  it("starts PAUSE and needs concrete facts before moving on", () => {
    let s = newSession({ id: "r", conflictId: "c", userId: "u", relationshipId: null, nowMs: NOW });
    expect(s.stage).toBe("PAUSE");
    s = transition(s, { type: "NEXT" }).session;
    expect(s.stage).toBe("FACTS");
    expect(transition(s, { type: "NEXT" }).refused).toMatch(/concretely happened/);
    s = transition(s, { type: "ANSWER", answers: { concreteEvent: "We argued about dinner." } }).session;
    expect(transition(s, { type: "NEXT" }).session.stage).toBe("IMPACT");
  });
  it("can't reach SHARE except from REVIEW with a valid message; exit is always possible", () => {
    const s = S({ concreteEvent: "x" }, "IMPACT");
    expect(transition(s, { type: "CONFIRM_SHARE_READY" }, { messageValid: true }).refused).toBeTruthy();
    const r = S({ concreteEvent: "x" }, "REVIEW");
    expect(transition(r, { type: "CONFIRM_SHARE_READY" }, { messageValid: false }).refused).toBeTruthy();
    expect(transition(r, { type: "CONFIRM_SHARE_READY" }, { messageValid: true, shareBlocked: true }).refused).toBeTruthy();
    expect(transition(r, { type: "CONFIRM_SHARE_READY" }, { messageValid: true }).session.shareState).toBe("READY_TO_SHARE");
    for (const st of ["PAUSE", "FACTS", "REVIEW", "SAFETY_HOLD"] as const) expect(transition(S({}, st), { type: "EXIT" }).session.stage).toBe("EXITED");
  });
});

describe("B. fact / interpretation separation", () => {
  it("'You cancelled dinner again, so clearly I'm not important to you.'", async () => {
    const sp = splitFactFromInterpretation("You cancelled dinner again, so clearly I'm not important to you.");
    expect(sp).toMatchObject({ fact: "You cancelled dinner.", interpretation: "I'm not important to you", hadGlobalizing: true });
    const { result: r } = await prep({ concreteEvent: "You cancelled dinner again, so clearly I'm not important to you.", myExperience: "I felt disappointed" });
    expect(r.facts[0].text).toBe("You cancelled dinner.");
    expect(r.partnerUnderstanding[0]).toMatchObject({ kind: "INTERPRETATION" });
    expect(r.partnerUnderstanding[0].text).toMatch(/It may feel to you as though this means: “I'm not important to you”/);
    expect(r.unknowns.some((u) => /reason behind it is unknown/.test(u.text))).toBe(true);
    expect(r.repairQuestions[0].text).toBe("What was happening for you when you cancelled dinner?");
    expect(blob(r)).not.toMatch(/doesn'?t value you|don'?t care about you/i);
    expect(r.proposedMessage).not.toMatch(/not important to you/);
  });
});

describe("C. responsibility without blame", () => {
  it("owns a specific behaviour, no apology unless asked", async () => {
    const r = (await prep({ concreteEvent: "We argued about the trip.", myResponsibility: "I raised my voice" })).result;
    expect(r.proposedMessage).toContain("I take responsibility for this part: I raised my voice.");
    expect(r.proposedMessage).not.toMatch(/sorry/i);
    expect((await prep({ concreteEvent: "We argued.", myResponsibility: "I raised my voice", apologize: true })).result.proposedMessage).toMatch(/I'm sorry\./);
  });
  it("blaming / globalising wording in the user's own field is left out with a note", async () => {
    const r = (await prep({ concreteEvent: "We argued.", myResponsibility: "I yelled but you always start it" })).result;
    expect(r.proposedMessage).not.toMatch(/you always/);
    expect(r.communicationNotes.some((n) => /left out/.test(n.text))).toBe(true);
  });
});

describe("D/E. boundaries and disagreement preserved", () => {
  it("\"I understand your request, but I can't agree to it because…\"", async () => {
    const r = (await prep({ concreteEvent: "You asked me to share my location all the time.", boundary: "continuous location sharing crosses a line for me", cannotAgreeToRequest: true })).result;
    expect(r.proposedMessage).toContain("I understand your request, but I can't agree to it, because continuous location sharing crosses a line for me.");
    expect(r.quality.preservesBoundary).toBe(true);
  });
  it("\"I understand why this hurt, but I remember it differently\" and \"…I don't agree with every interpretation\"", async () => {
    const other = (await prep({ partnerSaid: "You embarrassed me at dinner.", myResponsibility: "I made a joke about your job", rememberDifferently: true })).result;
    expect(other.proposedMessage).toContain("I understand this mattered to you, but I remember it differently."); // "hurt" not claimed when not said
    const r = (await prep({ partnerSaid: "You embarrassed me at dinner and it hurt.", myResponsibility: "I made a joke about your job", rememberDifferently: true, disagreeWithInterpretation: true })).result;
    expect(r.proposedMessage).toContain("I understand why this hurt, but I remember it differently.");
    expect(r.proposedMessage).toContain("I take responsibility for what I did, but I don't agree with every interpretation of it.");
    expect(r.proposedMessage).not.toMatch(/you'?re right|my fault/i);
    expect(r.quality.preservesDisagreement).toBe(true);
  });
  it("a model draft that drops the boundary is rejected", async () => {
    const m: RepairRephraser = { modelVersion: "m", rephraseRepair: async () => ({ proposedMessage: "Okay, I'll share my location with you from now on." }) };
    const o = await prep({ concreteEvent: "You asked for my location.", boundary: "I won't share my live location", cannotAgreeToRequest: true }, { model: m });
    expect(o.usedModel).toBe(false);
  });
});

describe("F/P/Q. grounding: no invented partner words, feelings, intent or history", () => {
  const a: RepairAnswers = { concreteEvent: "You didn't reply to my message.", myExperience: "I felt ignored" };
  for (const t of ["You said you were bored of me.", "I know you feel guilty.", "You obviously don't care.", "This is the third time you've done this.", "You only did it to hurt me."]) {
    it(`rejects: ${t}`, () => expect(validateRepairComponent({ kind: "UNDERSTAND", text: t, sources: [] }, a).length).toBeGreaterThan(0));
  }
  it("rejects quotes of words nobody supplied", () => {
    expect(validateRepairComponent({ kind: "ACKNOWLEDGE", text: "I understand that you said: “I'm done with this”.", sources: [] }, a).some((i) => i.check === "INVENTED_PARTNER_WORDS")).toBe(true);
  });
  it("every statement and component has sources", async () => {
    const r = (await prep({ ...a, myResponsibility: "I got defensive", partnerSaid: "You never listen.", partnerSaidMessageId: "m9", partnerSaidAt: "2026-09-25T10:00:00Z" })).result;
    for (const c of r.components) expect(c.sources.length).toBeGreaterThan(0);
    for (const s of [...r.facts, ...r.partnerUnderstanding, ...r.unknowns]) expect(s.sources.length).toBeGreaterThan(0);
    expect(r.components[0].sources[0]).toMatchObject({ sourceType: "PARTNER_MESSAGE", sourceMessageId: "m9", sourcePartner: "PARTNER" });
  });
});

describe("G/O. safety / coercion gate (fails closed)", () => {
  const concerns: [string, RepairAnswers][] = [
    ["threat", { concreteEvent: "He threatened to hurt me if I leave." }],
    ["violence", { whatHappened: "She pushed me into the wall." }],
    ["monitoring", { concreteEvent: "He installed an app to track my phone." }],
    ["isolation", { concreteEvent: "He won't let me see my friends." }],
    ["financial", { concreteEvent: "She controls all my money." }],
    ["blackmail", { concreteEvent: "They threatened to post my photos." }],
    ["sexual coercion", { concreteEvent: "He pressured me to have sex after I said no, he didn't stop when I said no." }],
    ["self-harm as control", { partnerSaid: "I'll kill myself if you leave.", concreteEvent: "She said she would kill herself if I leave." }],
    ["children", { concreteEvent: "He said he'd hurt the kids." }],
    ["immediate", { concreteEvent: "He is outside my door right now." }],
  ];
  for (const [name, a] of concerns) {
    it(name, async () => {
      const { result: r } = await prep(a);
      expect(r.safetyState.status).toBe("CONCERN");
      expect(r.stage).toBe("SAFETY_HOLD");
      expect(r.proposedMessage).toBe("");
      expect(r.shareable).toBe(false);
      expect(blob(r.components)).toBe("[]");
    });
  }
  it("safety hold blocks every forward transition and survives later edits", () => {
    let s = S({}, "FACTS");
    s = transition(s, { type: "ANSWER", answers: { concreteEvent: "She hit me." } }).session;
    expect(s.stage).toBe("SAFETY_HOLD");
    s = transition(s, { type: "ANSWER", answers: { concreteEvent: "We argued." } }).session;
    expect(s.safetyState.status).toBe("CONCERN");
    for (const e of [{ type: "NEXT" }, { type: "CONFIRM_SHARE_READY" }, { type: "DONE" }] as const) expect(transition(s, e, { messageValid: true }).refused).toMatch(/Safety hold/);
  });
  it("fails closed on malformed input", () => {
    expect(checkSafety({ concreteEvent: 42 as unknown as string }).status).toBe("CONCERN");
  });
  it("ordinary disagreement is not flagged", () => {
    expect(checkSafety({ concreteEvent: "We argued about whose turn it was to cook.", myExperience: "I felt frustrated" }).status).toBe("CLEAR");
  });
});

describe("H/I/J. consent, sharing, withdrawal (state level)", () => {
  it("PRIVATE → READY_TO_SHARE → SHARED → WITHDRAWN; nothing is shareable after DONT_SHARE", async () => {
    let s = S({ concreteEvent: "x" }, "REVIEW");
    expect(s.shareState).toBe("PRIVATE");
    s = transition(s, { type: "CONFIRM_SHARE_READY" }, { messageValid: true }).session;
    expect(transition(s, { type: "WITHDRAWN" }).session.shareState).toBe("WITHDRAWN"); // before transmission
    s = transition(s, { type: "SHARED", shareId: "sh1" }).session;
    expect(s.shareState).toBe("SHARED");
    expect(transition(s, { type: "WITHDRAWN" }).session.shareState).toBe("WITHDRAWN");
    expect((await prep({ concreteEvent: "We argued.", myResponsibility: "I left" }, { edits: ["DONT_SHARE"] })).result.shareable).toBe(false);
  });
});

describe("K. privacy / no network in the repair core", () => {
  it("only share.ts may reach the network; nothing logs, stores or reports content", () => {
    for (const f of readdirSync("src/lib/relationship/repair")) {
      const s = readFileSync(`src/lib/relationship/repair/${f}`, "utf8");
      expect(s, f).not.toMatch(/\bfetch\s*\(|localStorage|sessionStorage|indexedDB|console\.(log|info|warn|error)|from\s+["'][^"']*(telemetry|analytics|e2eCloud|crash)/);
      if (f !== "share.ts") expect(s, f).not.toMatch(/from\s+["'][^"']*(supabase|sharing)["']/);
    }
  });
});

describe("L. fallback", () => {
  it("rule-based output without a model; unsafe/malformed/slow models never reach the user", async () => {
    const a: RepairAnswers = { concreteEvent: "You cancelled dinner.", myResponsibility: "I didn't tell you earlier that I might be late", willingToDo: "text you as soon as plans change" };
    const base = await prep(a);
    expect(base.usedModel).toBe(false);
    expect(base.result.proposedMessage).toContain("Next time, I can text you as soon as plans change.");
    for (const out of [{ proposedMessage: "You need to forgive me now." }, { proposedMessage: "Everything will be okay." }, { proposedMessage: "Check her phone first." }, "junk", null]) {
      const o = await prep(a, { model: { modelVersion: "m", rephraseRepair: async () => out }, timeoutMs: 30 });
      expect(o.usedModel).toBe(false);
      expect(o.result.proposedMessage).toBe(base.result.proposedMessage);
    }
    const slow = await prep(a, { model: { modelVersion: "m", rephraseRepair: () => new Promise(() => {}) }, timeoutMs: 20 });
    expect(slow.usedModel).toBe(false);
  });
  it("nothing to work with → INSUFFICIENT_INFORMATION", async () => {
    expect((await prep({})).result.proposedMessage).toBe("INSUFFICIENT_INFORMATION");
  });
  it("valid model rephrasing is used and carries versions", async () => {
    const o = await prep({ concreteEvent: "You cancelled dinner.", myResponsibility: "I didn't explain" }, { model: { modelVersion: "local-x", rephraseRepair: async () => ({ proposedMessage: "I'd like to talk about dinner. I didn't explain, and I take responsibility for that. What was happening for you?" }) } });
    expect(o.usedModel).toBe(true);
    expect(o.result).toMatchObject({ executionMode: "LOCAL", modelVersion: "local-x", validatorVersion: "repair-validator-v1", contractVersion: "repair-contract-v1" });
  });
});

describe("N. globalising language → specific observation (not blocked)", () => {
  it("'You never listen to me.'", async () => {
    const r = (await prep({ whatHappened: "You never listen to me.", myExperience: "I felt unheard when I explained what happened yesterday" })).result;
    expect(r.communicationNotes.some((n) => /generalising words/.test(n.text))).toBe(true);
    expect(r.communicationNotes.some((n) => n.text.startsWith("A more specific version could be"))).toBe(true);
    expect(r.facts[0].text).not.toMatch(/never/);
  });
});

describe("edits change the draft, never the reflection", () => {
  const a: RepairAnswers = { concreteEvent: "You cancelled dinner.", myResponsibility: "I snapped at you", apologize: true, stillNeedToExplain: "I was stressed about work", wantToUnderstand: "why the plan changed", specificChange: "tell me earlier if plans change", boundary: "I need a few hours before talking" };
  it("each edit changes the message; answers untouched", async () => {
    const base = (await prep(a)).result;
    for (const e of ["TOO_APOLOGETIC", "TOO_DEFENSIVE", "TOO_FORMAL", "MAKE_SHORTER", "ASK_INSTEAD_OF_ASSUME", "NOT_WHAT_I_MEANT"] as const) {
      const r = (await prep(a, { edits: [e] })).result;
      expect(r.proposedMessage, e).not.toBe(base.proposedMessage);
      expect(r.facts).toEqual(base.facts);
    }
    expect((await prep(a, { edits: ["KEEP_MY_BOUNDARY", "MAKE_SHORTER"] })).result.proposedMessage).toMatch(/I need a few hours before talking/);
  });
});

describe("pause is optional and textual only", () => {
  it("organize never infers escalation from capitals/punctuation", () => {
    const o = organize({ whatHappened: "WHY DID YOU DO THAT?!?!" });
    expect(blob(o)).not.toMatch(/escalat|angry|furious/i);
  });
});

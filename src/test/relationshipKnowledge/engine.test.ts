import { describe, it, expect } from "vitest";
import { NOW, UA, UB, DYAD, SNAP, obs, run, dim, RHYTHM } from "./fixtures";
import { productionSnapshot, resolveFact, dyadicView, explainAll, explainWhy, deriveTier, type Rule } from "../../lib/relationship/knowledge/index";

describe("explicit evidence & communication difference", () => {
  it("different stated rhythms → 'different', moderate at most, with a full trace", () => {
    const out = run([RHYTHM("A", "frequent_short"), RHYTHM("B", "infrequent_long")]);
    const c = dim(out, "communication");
    expect(c.state).toBe("different");
    expect(c.confidence).toBe("moderate");
    expect(c.traces).toHaveLength(1);
    expect(c.traces[0].ruleKey).toBe("RULE-COMM-001");
    expect(c.traces[0].observationIds).toHaveLength(2);
    expect(c.perspective).toBe("both_partner_reports");
  });
  it("same rhythms → aligned", () => {
    expect(dim(run([RHYTHM("A", "frequent_short"), RHYTHM("B", "frequent_short")]), "communication").state).toBe("aligned");
  });
  it("different conflict first-steps → different (conflict dimension)", () => {
    const out = run([
      obs({ by: "A", about: "A", c: "conflict_resolution", k: "first_step", v: "talk_now" }),
      obs({ by: "B", about: "B", c: "conflict_resolution", k: "first_step", v: "space_first" })]);
    expect(dim(out, "conflict").state).toBe("different");
  });
  it("support: active-constructive response to good news → positive_evidence", () => {
    const out = run([obs({ by: "A", about: "A", c: "capitalization", k: "partner_response", v: "active_constructive" })]);
    expect(dim(out, "support").state).toBe("positive_evidence");
    expect(dim(out, "support").traces[0].claimKeys).toEqual(["CLM-CAPITALIZATION"]);
  });
  it("responsiveness: feeling understood / not understood are self-report perceptions", () => {
    expect(dim(run([obs({ by: "A", about: "A", c: "partner_responsiveness", k: "feels_understood", v: true })]), "responsiveness").state).toBe("positive_evidence");
    const neg = dim(run([obs({ by: "A", about: "A", c: "partner_responsiveness", k: "feels_understood", v: false })]), "responsiveness");
    expect(neg.state).toBe("negative_evidence");
    expect(neg.limitations.join(" ")).toMatch(/perception/);
  });
});

describe("unknown / insufficient", () => {
  it("no evidence → unknown, never forced positive or negative", () => {
    const out = run([]);
    for (const d of ["communication", "conflict", "responsiveness", "support", "trust"] as const) expect(dim(out, d).state).toBe("unknown");
  });
  it("only one partner answered → insufficient_evidence, not a verdict", () => {
    expect(dim(run([RHYTHM("A", "frequent_short")]), "communication").state).toBe("insufficient_evidence");
  });
});

describe("inferred evidence never becomes explicit", () => {
  it("inferred rhythm does not satisfy a rule that needs stated evidence", () => {
    const out = run([RHYTHM("A", "frequent_short", { kind: "inferred" }), RHYTHM("B", "infrequent_long")]);
    expect(dim(out, "communication").state).toBe("insufficient_evidence");
  });
  it("resolved fact keeps tier=inferred and state=inferred", () => {
    const f = resolveFact([RHYTHM("A", "frequent_short", { kind: "inferred" })], "A", DYAD, "communication_preferences", "rhythm", NOW);
    expect(f.state).toBe("inferred"); expect(f.tier).toBe("inferred");
  });
  it("a mislabelled stored tier cannot promote an inference (tier is re-derived)", () => {
    const o = { ...RHYTHM("A", "frequent_short", { kind: "inferred" }), evidenceTier: "explicit_self_report" as const };
    expect(deriveTier(o)).toBe("inferred");
  });
  it("explicit evidence outranks inferred evidence about the same thing", () => {
    const f = resolveFact([RHYTHM("A", "infrequent_long", { kind: "inferred" }), RHYTHM("A", "frequent_short")], "A", DYAD, "communication_preferences", "rhythm", NOW);
    expect(f.value).toBe("frequent_short"); expect(f.state).toBe("known");
  });
});

describe("partner perspective & mutual confirmation", () => {
  it("A's report about B is NOT B's own statement (rule needing B's side does not fire)", () => {
    const out = run([RHYTHM("A", "frequent_short"), obs({ by: "A", about: "B", c: "communication_preferences", k: "rhythm", v: "infrequent_long" })]);
    expect(dim(out, "communication").state).toBe("insufficient_evidence");
  });
  it("B's own statement wins over A's contrary report; the discrepancy is surfaced, not merged", () => {
    const list = [RHYTHM("B", "frequent_short"), obs({ by: "A", about: "B", c: "communication_preferences", k: "rhythm", v: "infrequent_long" })];
    const f = resolveFact(list, "B", DYAD, "communication_preferences", "rhythm", NOW);
    expect(f.value).toBe("frequent_short"); expect(f.discrepantPartnerReport).toBe("infrequent_long");
    const v = dyadicView(list, DYAD, "communication_preferences", "rhythm", NOW);
    expect(v.discrepancies).toEqual([{ subject: "B", ownValue: "frequent_short", reportedByPartner: "infrequent_long" }]);
    expect(v.A_to_B).toBe("infrequent_long");
  });
  it("a confirmed partner report counts as B's side", () => {
    const out = run([RHYTHM("A", "frequent_short"), obs({ by: "A", about: "B", c: "communication_preferences", k: "rhythm", v: "infrequent_long", kind: "partner_confirmed" })]);
    expect(dim(out, "communication").state).toBe("different");
  });
  it("self-report + agreeing confirmed partner report → mutually_confirmed", () => {
    const f = resolveFact([RHYTHM("B", "infrequent_long"), obs({ by: "A", about: "B", c: "communication_preferences", k: "rhythm", v: "infrequent_long", kind: "partner_confirmed" })], "B", DYAD, "communication_preferences", "rhythm", NOW);
    expect(f.tier).toBe("mutually_confirmed"); expect(f.state).toBe("confirmed");
  });
  it("a partner report the subject disputed is not usable evidence", () => {
    const disputed = { ...obs({ by: "A", about: "B", c: "communication_preferences", k: "rhythm", v: "infrequent_long" }), confirmationStatus: "disputed" as const };
    expect(resolveFact([disputed], "B", DYAD, "communication_preferences", "rhythm", NOW).state).toBe("unknown");
  });
  it("one partner's report about the other yields low confidence at most", () => {
    const out = run([obs({ by: "A", about: "B", c: "partner_responsiveness", k: "in_person_attentive", v: true })]);
    const r = dim(out, "responsiveness");
    expect(r.state).toBe("positive_evidence"); expect(r.confidence).toBe("low"); expect(r.perspective).toBe("one_partner_report_about_other");
  });
});

describe("contradictory evidence", () => {
  it("partners describing time together differently → contradictory, not averaged", () => {
    const out = run([obs({ by: "A", about: "DYAD", c: "quality_time", k: "together_frequency", v: "often" }), obs({ by: "B", about: "DYAD", c: "quality_time", k: "together_frequency", v: "rarely" })]);
    expect(dim(out, "quality_time").state).toBe("contradictory");
    expect(dim(out, "quality_time").statementKeys).toEqual(["contradictory.generic"]);
  });
  it("partners agreeing → positive_evidence", () => {
    const out = run([obs({ by: "A", about: "DYAD", c: "quality_time", k: "together_frequency", v: "often" }), obs({ by: "B", about: "DYAD", c: "quality_time", k: "together_frequency", v: "often" })]);
    expect(dim(out, "quality_time").state).toBe("positive_evidence");
  });
  it("same person changing their answer later: newest wins, history is retained", () => {
    const old = RHYTHM("A", "infrequent_long", { age: 40 }), recent = RHYTHM("A", "frequent_short", { age: 2 });
    const f = resolveFact([old, recent], "A", DYAD, "communication_preferences", "rhythm", NOW);
    expect(f.value).toBe("frequent_short");
    expect(old.value).toBe("infrequent_long"); // not overwritten
  });
  it("two differing statements at the identical instant are contradictory", () => {
    const a = RHYTHM("A", "frequent_short", { age: 3 }), b = RHYTHM("A", "infrequent_long", { age: 3 });
    expect(resolveFact([a, b], "A", DYAD, "communication_preferences", "rhythm", NOW).state).toBe("contradictory");
  });
});

describe("temporal model & staleness", () => {
  it("communication preference older than ~six months and unconfirmed is stale, not current fact", () => {
    const f = resolveFact([RHYTHM("A", "frequent_short", { age: 200 })], "A", DYAD, "communication_preferences", "rhythm", NOW);
    expect(f.state).toBe("stale"); expect(f.confidence).toBe(0);
    expect(f.reason).toMatch(/history/);
  });
  it("stale evidence cannot fire a rule", () => {
    const out = run([RHYTHM("A", "frequent_short", { age: 200 }), RHYTHM("B", "infrequent_long")]);
    expect(dim(out, "communication").state).toBe("insufficient_evidence");
    expect(dim(out, "communication").limitations.join(" ")).toMatch(/out of date/);
  });
  it("reconfirming refreshes an old preference", () => {
    const f = resolveFact([RHYTHM("A", "frequent_short", { age: 200, reconfirmedAge: 5 })], "A", DYAD, "communication_preferences", "rhythm", NOW);
    expect(f.state).toBe("known");
  });
  it("confidence decays with age", () => {
    const fresh = resolveFact([RHYTHM("A", "frequent_short", { age: 1 })], "A", DYAD, "communication_preferences", "rhythm", NOW);
    const older = resolveFact([RHYTHM("A", "frequent_short", { age: 120 })], "A", DYAD, "communication_preferences", "rhythm", NOW);
    expect(older.confidence < fresh.confidence).toBe(true); expect(older.state).toBe("known");
  });
  it("relationship direction goes stale quickly (60 days)", () => {
    const f = resolveFact([obs({ by: "A", about: "A", c: "relationship_direction", k: "wants_space", v: true, age: 90 })], "A", DYAD, "relationship_direction", "wants_space", NOW);
    expect(f.state).toBe("stale");
  });
  it("historical observations remain available after going stale", () => {
    const o = RHYTHM("A", "frequent_short", { age: 400 });
    const f = resolveFact([o], "A", DYAD, "communication_preferences", "rhythm", NOW);
    expect(f.observationIds).toEqual([o.observationId]); expect(f.value).toBe("frequent_short");
  });
});

describe("relationship stage", () => {
  const stageRule: Rule = { ...SNAP.rules.find((r) => r.ruleKey === "RULE-COMM-001")!, ruleKey: "RULE-TEST-STAGE", applicableStages: ["committed", "long_term"] };
  const snap = { ...SNAP, rules: [stageRule] };
  const list = [RHYTHM("A", "frequent_short"), RHYTHM("B", "infrequent_long")];
  it("a rule declaring stages fires only in them", () => {
    expect(dim(run(list, { stage: "committed", snapshot: snap }), "communication").state).toBe("different");
    expect(dim(run(list, { stage: "crush", snapshot: snap }), "communication").state).toBe("unknown");
    expect(dim(run(list, { stage: "separated", snapshot: snap }), "communication").state).toBe("unknown");
  });
});

describe("approved-only production reasoning", () => {
  it("the shipped snapshot has NO executable rules until humans approve claims/sources/rules", () => {
    const out = run([RHYTHM("A", "frequent_short"), RHYTHM("B", "infrequent_long")], { snapshot: productionSnapshot() });
    for (const d of Object.values(out.dimensions)) expect(d.traces).toHaveLength(0);
    expect(dim(out, "communication").state).not.toBe("different");
  });
  it("a rule backed by a claim whose source is unverified does not run", () => {
    const snap = { ...SNAP, sources: SNAP.sources.map((s) => (s.sourceKey === "gable-et-al-2004" ? { ...s, identifiersVerified: false } : s)) };
    const out = run([obs({ by: "A", about: "A", c: "capitalization", k: "partner_response", v: "active_constructive" })], { snapshot: snap });
    expect(dim(out, "support").state).toBe("unknown");
  });
  it("a retracted source disables dependent rules", () => {
    const snap = { ...SNAP, sources: SNAP.sources.map((s) => (s.sourceKey === "gable-et-al-2004" ? { ...s, retractionStatus: "retracted" as const } : s)) };
    expect(dim(run([obs({ by: "A", about: "A", c: "capitalization", k: "partner_response", v: "active_constructive" })], { snapshot: snap }), "support").traces).toHaveLength(0);
  });
});

describe("rule provenance & traceability (acceptance criterion)", () => {
  it("evidence-claim rule: observation → rule → claim → source chain is complete", () => {
    const out = run([obs({ by: "A", about: "A", c: "partner_responsiveness", k: "feels_understood", v: true, id: "o-1" })]);
    const t = dim(out, "responsiveness").traces[0];
    const why = explainWhy(t, SNAP);
    expect(why.complete).toBe(true);
    expect(why.steps.map((s) => s.level)).toEqual(["observation", "rule", "claim", "source"]);
    expect(t.observationIds).toEqual(["o-1"]);
    expect(t.claimKeys).toEqual(["CLM-PPR-CONSTRUCT"]); expect(t.sourceKeys).toEqual(["reis-clark-holmes-2004"]);
    expect(t.knowledgeVersion).toBe(SNAP.knowledgeVersion);
  });
  it("every executable rule is either descriptive or resolves to claims → sources", () => {
    for (const r of SNAP.rules) {
      if (r.ruleBasis === "evidence_claim") {
        expect(r.claimKeys.length).toBeGreaterThan(0);
        for (const ck of r.claimKeys) { const c = SNAP.claims.find((x) => x.claimKey === ck); expect(!!c).toBe(true); expect(c!.sourceKeys.length).toBeGreaterThan(0); }
      } else expect(r.claimKeys).toHaveLength(0);
    }
  });
  it("explanations carry the full contract and contain no raw text or scores", () => {
    const ex = explainAll(run([RHYTHM("A", "frequent_short"), RHYTHM("B", "infrequent_long")]), SNAP, NOW);
    expect(ex).toHaveLength(1);
    const e = ex[0];
    expect(e.statement).toBe("Your communication rhythms seem different.");
    for (const k of ["dimension", "state", "confidence", "evidenceSummary", "evidenceSourceType", "perspective", "limitations", "timestamp", "knowledgeVersion", "ruleVersion"]) expect(k in e).toBe(true);
    expect(e.statement).not.toMatch(/%|score|compatib/i);
  });
  it("engine is deterministic", () => {
    const l = [RHYTHM("A", "frequent_short"), RHYTHM("B", "infrequent_long")];
    expect(JSON.stringify(run(l))).toBe(JSON.stringify(run(l)));
  });
});

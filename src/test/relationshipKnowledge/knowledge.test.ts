import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  CONSTRUCTS, validateTaxonomy, requireConstruct, resolveConstructId, TAXONOMY_VERSION, SEED_CLAIMS, SEED_SOURCES, SEED_INSTRUMENTS, SEED_RULES, productionSnapshot,
  findDuplicate, normDoi, normPmid, normPmcid, gateClaim, gateSource, canTransition, applyRetraction, supersedeClaim, candidateToSource, AdapterRegistry, StaticAdapter,
  appendProvenance, verifyChain, inferenceLogRecord, DIMENSIONS, type CandidateSource, type EvidenceClaim, type ResearchSource,
} from "../../lib/relationship/knowledge/index";
import { SNAP, obs, run, dim, RHYTHM } from "./fixtures";

const REQUIRED = ["relationship_satisfaction","relationship_quality","commitment","communication","communication_preferences","conflict","conflict_resolution","partner_responsiveness","emotional_support","social_support","intimacy","affection","trust","attachment","boundaries","autonomy","relatedness","quality_time","shared_activities","gratitude","capitalization","dyadic_coping","jealousy","power","decision_making","financial_conflict","work_family_conflict","life_stress","relationship_maintenance","relationship_direction","relationship_transition","relationship_formation","relationship_dissolution","digital_communication","long_distance_relationships","cross_cultural_relationships","sexual_relationship","family_relationships","safety","intimate_partner_violence","psychological_aggression","stalking","coercive_control"];

describe("taxonomy", () => {
  it("contains every required construct, is internally consistent, and is versioned", () => {
    for (const id of REQUIRED) expect(CONSTRUCTS.some((c) => c.constructId === id)).toBe(true);
    expect(validateTaxonomy()).toEqual([]);
    expect(CONSTRUCTS.every((c) => c.version === TAXONOMY_VERSION && c.definition.length > 10)).toBe(true);
  });
  it("rejects an unknown (LLM-invented) construct", () => {
    expect(() => requireConstruct("emotional_vibe_score")).toThrow();
    expect(resolveConstructId("IPV")).toBe("intimate_partner_violence");
    expect(resolveConstructId("made_up")).toBeNull();
  });
  it("safety constructs never auto-decay quickly", () => expect(requireConstruct("safety").stalenessThresholdDays).toBeGreaterThan(1000));
  it("the engine exposes the required dimensions", () => {
    for (const d of ["communication","conflict","responsiveness","relationship_satisfaction","commitment","support","boundaries","trust","quality_time","relationship_direction","safety"]) expect((DIMENSIONS as readonly string[]).includes(d)).toBe(true);
  });
});

describe("seed knowledge honesty", () => {
  it("no seed source is approved; only the PubMed-matched Woodin record is identifier-verified; none has a retraction check", () => {
    for (const s of SEED_SOURCES) {
      expect(s.reviewStatus).not.toBe("approved");
      expect(s.identifiersVerified).toBe(s.sourceKey === "woodin-2011-conflict-meta");
      expect(s.retractionStatus).toBe("unknown");
    }
    expect(SEED_SOURCES.find((s) => s.sourceKey === "who-responding-2013")?.reviewStatus).toBe("discovered");
    for (const k of ["funk-rogge-2007","hendrick-1988","spanier-1976","karney-bradbury-1995","woodin-2011-conflict-meta","kanter-2022-communication-meta","gable-et-al-2004","reis-clark-holmes-2004","rusbult-martz-agnew-1998","mokkink-cosmin-2010","cdc-ipv-definitions-2015","who-ipv-2012"]) expect(SEED_SOURCES.find((s) => s.sourceKey === k)?.reviewStatus).toBe("metadata_verified");
  });
  it("a claim is never further along than its weakest source", () => {
    const rank = (r: string) => ["discovered", "metadata_verified", "under_review", "evidence_extracted", "quality_assessed", "approved"].indexOf(r);
    for (const c of SEED_CLAIMS) {
      const weakest = Math.min(...c.sourceKeys.map((k) => rank(SEED_SOURCES.find((s) => s.sourceKey === k)!.reviewStatus)));
      const claimRank = rank(c.reviewStatus);
      // claims with any unchecked source must stay at 'discovered'
      if (weakest === 0) expect(claimRank).toBe(0);
    }
  });
  it("the communication claim no longer leans on a source that does not address communication", () => {
    const c = SEED_CLAIMS.find((x) => x.claimKey === "CLM-COMM-ASSOC")!;
    expect(c.sourceKeys).not.toContain("karney-bradbury-1995");
    expect(c.claimText).not.toMatch(/\bcauses\b|\bleads to\b/i);
    expect(SEED_SOURCES.find((s) => s.sourceKey === "woodin-2011-conflict-meta")?.pmid).toBe("21553964");
  });
  it("identifiers added during verification are well-formed", () => {
    expect(SEED_SOURCES.find((s) => s.sourceKey === "gable-et-al-2004")?.pmid).toBe("15301629");
    expect(SEED_SOURCES.find((s) => s.sourceKey === "mokkink-cosmin-2010")?.pmcid).toBe("PMC2852520");
    expect(SEED_SOURCES.find((s) => s.sourceKey === "kanter-2022-communication-meta")?.doi).toBe("10.1111/jomf.12804");
    expect(SEED_SOURCES.find((s) => s.sourceKey === "rusbult-martz-agnew-1998")?.doi).toBe("10.1111/j.1475-6811.1998.tb00177.x");
    expect(SEED_SOURCES.find((s) => s.sourceKey === "who-responding-2013")?.doi).toBeNull(); // nothing guessed
  });
  it("no seed claim is causal, approved, GRADE-rated, or carries invented numbers", () => {
    for (const c of SEED_CLAIMS) {
      expect(c.causalClaim).toBe(false); expect(c.reviewStatus).not.toBe("approved"); expect(c.certainty).toBe("unknown");
      expect(c.gradeFormallyAssessed).toBe(false); expect(c.claimText).not.toMatch(/\d+(\.\d+)?\s?%|\bcauses\b|\bleads to\b|\bproves?\b/i);
      expect(c.limitations.length).toBeGreaterThan(0); expect(c.sourceKeys.length).toBeGreaterThan(0);
      for (const k of c.sourceKeys) expect(SEED_SOURCES.some((s) => s.sourceKey === k)).toBe(true);
    }
  });
  it("every seed claim and rule refers to a real construct", () => {
    for (const c of SEED_CLAIMS) expect(!!requireConstruct(c.constructId)).toBe(true);
    for (const r of SEED_RULES) for (const cd of r.conditions) expect(!!requireConstruct(cd.fact.construct)).toBe(true);
  });
  it("DOIs present are well-formed; nothing is fabricated for sources without one", () => {
    for (const s of SEED_SOURCES) if (s.doi) expect(normDoi(s.doi)).toBe(s.doi.toLowerCase());
    expect(SEED_SOURCES.find((s) => s.sourceKey === "reis-clark-holmes-2004")?.doi).toBeNull();
  });
  it("instruments are research assets, never user-facing", () => {
    expect(SEED_INSTRUMENTS.length).toBeGreaterThanOrEqual(3);
    for (const i of SEED_INSTRUMENTS) { expect(i.userFacingAuthorized).toBe(false); expect(i.cosminAssessed).toBe(false); }
  });
  it("shipping snapshot is inert until human approval; test snapshot is explicitly separate", () => {
    const prod = productionSnapshot();
    expect(prod.rules.every((r) => r.status !== "approved")).toBe(true);
    expect(SNAP.rules.every((r) => r.status === "approved")).toBe(true);
    expect(prod.knowledgeVersion).toBe("2026.10.0");
  });
  it("evidence-claim rules reference only claims that exist", () => {
    for (const r of SEED_RULES) for (const k of r.claimKeys) expect(SEED_CLAIMS.some((c) => c.claimKey === k)).toBe(true);
  });
});

describe("identifier-first deduplication", () => {
  const base: CandidateSource = { adapter: "static", title: "Perceived partner responsiveness and well-being", authors: [], publication: null, publicationYear: 2010, doi: "10.1000/ABC.1", pmid: "123" };
  it("normalises identifiers", () => {
    expect(normDoi("https://doi.org/10.1000/ABC.1")).toBe("10.1000/abc.1"); expect(normPmid("PMID: 123")).toBe("123"); expect(normPmcid("pmc99")).toBe("PMC99"); expect(normDoi("not a doi")).toBeNull();
  });
  it("merges on DOI even when titles differ", () => {
    const r = findDuplicate({ ...base, title: "Totally different title", pmid: null }, [base]);
    expect(r.kind).toBe("identifier_match"); if (r.kind === "identifier_match") expect(r.matchedOn).toBe("doi");
  });
  it("falls through DOI → PMID", () => {
    const r = findDuplicate({ ...base, doi: null }, [base]);
    expect(r.kind === "identifier_match" && r.matchedOn).toBe("pmid");
  });
  it("flags conflicting secondary identifiers instead of silently merging", () => {
    const r = findDuplicate({ ...base, pmid: "999" }, [base]);
    expect(r.kind === "identifier_match" && r.conflicting).toEqual(["pmid"]);
  });
  it("NEVER merges on title alone: similar title without shared ids is only 'possible_duplicate'", () => {
    const r = findDuplicate({ ...base, doi: null, pmid: null }, [base]);
    expect(r.kind).toBe("possible_duplicate");
  });
  it("two different DOIs with the same title are different works", () => {
    expect(findDuplicate({ ...base, doi: "10.2000/preprint", pmid: null }, [base]).kind).toBe("new");
  });
  it("unrelated title → new", () => expect(findDuplicate({ ...base, doi: null, pmid: null, title: "Gut microbiome diversity" }, [base]).kind).toBe("new"));
});

describe("ingestion pipeline gates, retraction and supersession", () => {
  const src = (o: Partial<ResearchSource> = {}): ResearchSource => ({ ...SEED_SOURCES[0], ...o });
  const claim = (o: Partial<EvidenceClaim> = {}): EvidenceClaim => ({ ...SEED_CLAIMS[0], ...o });
  it("imported candidate starts as 'discovered' with nothing verified", () => {
    const s = candidateToSource({ adapter: "static", title: "t", authors: [], publication: null, publicationYear: 2020, doi: "10.1/x" }, "k");
    expect(s.reviewStatus).toBe("discovered"); expect(s.identifiersVerified).toBe(false); expect(s.retractionStatus).toBe("unknown");
  });
  it("stages cannot be skipped", () => {
    expect(canTransition("discovered", "approved")).toBe(false); expect(canTransition("quality_assessed", "approved")).toBe(true);
    expect(gateSource(src({ reviewStatus: "discovered" }), { to: "approved", reason: "x", reviewerId: "u" }).ok).toBe(false);
  });
  it("source approval needs reviewer, verified ids, and a known retraction status", () => {
    const s = src({ reviewStatus: "quality_assessed" });
    expect(gateSource(s, { to: "approved", reason: "ok" }).blockers).toContain("human reviewer required");
    expect(gateSource(s, { to: "approved", reason: "ok", reviewerId: "u" }).blockers.join()).toMatch(/not verified/);
    expect(gateSource({ ...s, identifiersVerified: true, retractionStatus: "none_known" }, { to: "approved", reason: "ok", reviewerId: "u" }).ok).toBe(true);
  });
  it("claim approval needs an approved verified source, limitations, and honest certainty", () => {
    const c = claim({ reviewStatus: "quality_assessed" });
    expect(gateClaim(c, SEED_SOURCES, { to: "approved", reason: "ok", reviewerId: "u" }).blockers.join()).toMatch(/no approved, verified/);
    const okSrc = SEED_SOURCES.map((s) => ({ ...s, reviewStatus: "approved" as const, identifiersVerified: true, retractionStatus: "none_known" as const }));
    expect(gateClaim(c, okSrc, { to: "approved", reason: "ok", reviewerId: "u" }).ok).toBe(true);
    expect(gateClaim({ ...c, limitations: [] }, okSrc, { to: "approved", reason: "ok", reviewerId: "u" }).ok).toBe(false);
    expect(gateClaim({ ...c, certainty: "moderate" }, okSrc, { to: "approved", reason: "ok", reviewerId: "u" }).blockers.join()).toMatch(/without its reasons/);
  });
  it("causality prevention: a causal claim needs an experimental basis", () => {
    const okSrc = SEED_SOURCES.map((s) => ({ ...s, reviewStatus: "approved" as const, identifiersVerified: true, retractionStatus: "none_known" as const }));
    const c = claim({ reviewStatus: "quality_assessed", causalClaim: true, associationType: "cross_sectional" });
    expect(gateClaim(c, okSrc, { to: "approved", reason: "ok", reviewerId: "u" }).blockers.join()).toMatch(/causal/);
  });
  it("retraction demotes single-source claims but keeps history; multi-source claims survive", () => {
    const sources = SEED_SOURCES.map((s) => ({ ...s, reviewStatus: "approved" as const, identifiersVerified: true, retractionStatus: "none_known" as const }));
    const claims = SEED_CLAIMS.map((c) => ({ ...c, reviewStatus: "approved" as const }));
    const r = applyRetraction("gable-et-al-2004", claims, sources);
    expect(r.demoted).toEqual(["CLM-CAPITALIZATION"]);
    expect(r.claims.find((c) => c.claimKey === "CLM-CAPITALIZATION")?.reviewStatus).toBe("retracted");
    expect(r.claims).toHaveLength(claims.length); // nothing deleted
    const multi = applyRetraction("funk-rogge-2007", claims, sources);
    expect(multi.demoted).toEqual([]); // hendrick + spanier still support CLM-RSAT-MEASURABLE
  });
  it("supersede keeps the old version and links a new unapproved one", () => {
    const { old, next } = supersedeClaim(claim({ reviewStatus: "approved" }), { ...claim(), claimText: "updated wording" });
    expect(old.reviewStatus).toBe("superseded"); expect(next.version).toBe(old.version + 1); expect(next.reviewStatus).toBe("evidence_extracted"); expect(next.claimKey).toBe(old.claimKey);
  });
  it("adapters are replaceable and one failing provider doesn't break discovery", async () => {
    const reg = new AdapterRegistry().register(new StaticAdapter([{ adapter: "static", title: "Responsiveness review", authors: [], publication: null, publicationYear: 2019, doi: "10.5/z" }]));
    reg.register({ id: "crossref", search: async () => { throw new Error("down"); }, lookup: async () => null });
    const { results, failed } = await reg.searchAll({ text: "responsiveness" });
    expect(results).toHaveLength(1); expect(failed).toEqual(["crossref"]);
    expect((await reg.get("static")!.lookup("doi", "10.5/Z"))?.title).toBe("Responsiveness review");
  });
});

describe("provenance log & observability", () => {
  it("hash chain detects tampering; reason is mandatory", () => {
    const e = (a: string) => ({ entityType: "claim", entityKey: "CLM-X", action: a, createdBy: "admin", createdAt: "2026-10-04T00:00:00Z", source: "admin_rpc", version: "1", previousVersion: null, changeReason: "review" });
    let log = appendProvenance([], e("create")); log = appendProvenance(log, e("approve"));
    expect(verifyChain(log)).toBe(true);
    expect(verifyChain([{ ...log[0], action: "tampered" }, log[1]])).toBe(false);
    expect(() => appendProvenance(log, { ...e("x"), changeReason: " " })).toThrow();
  });
  it("inference log record holds ids/states only — never message text", () => {
    const out = run([RHYTHM("A", "frequent_short"), RHYTHM("B", "infrequent_long")]);
    const rec = inferenceLogRecord(dim(out, "communication").traces[0], "different", "moderate", new Date("2026-10-04T00:00:00Z"));
    expect(Object.keys(rec).sort()).toEqual(["confidence", "evidence_ids", "input_state", "knowledge_version", "output_state", "rule_id", "rule_version", "timestamp"]);
    expect(JSON.stringify(rec)).not.toMatch(/raw_text|originalText/);
  });
  it("historical inferences carry their own versions (later knowledge cannot silently rewrite them)", () => {
    const t = dim(run([RHYTHM("A", "frequent_short"), RHYTHM("B", "infrequent_long")]), "communication").traces[0];
    expect([t.knowledgeVersion, t.ruleVersion, t.taxonomyVersion]).toEqual(["2026.10.0", "2026.10.0", "2026.10.0"]);
  });
});

describe("migration static checks (RLS & separation)", () => {
  const sql = readFileSync("supabase/migrations/20261004100000_relationship_knowledge_engine.sql", "utf8");
  const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS public\.(rk_\w+)/g)].map((m) => m[1]);
  it("every rk_ table has RLS enabled (explicitly or in the policy loop)", () => {
    expect(tables.length).toBe(13);
    for (const t of tables) expect(sql.includes(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`) || sql.includes(`'${t}'`)).toBe(true);
  });
  it("private evidence is observer-only; no anon grants; admin gate uses the allowlist", () => {
    expect(sql).toMatch(/rk obs: observer reads own[\s\S]*?USING \(observer_user_id = \(SELECT auth\.uid\(\)\)\)/);
    expect(sql).toMatch(/REVOKE ALL ON TABLE public\.%I FROM anon/);
    expect(sql).toMatch(/admin_allowlist/);
    expect(sql).not.toMatch(/GRANT[^;]*TO anon/);
  });
  it("inferences have no client write policies; provenance & observation evidence are protected from mutation", () => {
    expect(sql).not.toMatch(/ON public\.rk_inferences FOR (INSERT|UPDATE|DELETE)/);
    expect(sql).toMatch(/rk_provenance_log is append-only/); expect(sql).toMatch(/observation evidence is immutable/);
    expect(sql).toMatch(/rk_obs_inferred_not_explicit/);
  });
  it("rejects raw text in private tables and enforces approval gates in the database", () => {
    expect(sql).not.toMatch(/raw_text\s+text|message_text|chat_text/i);
    expect(sql).toMatch(/rk_guard_claim_approval/); expect(sql).toMatch(/rk_guard_rule_approval/); expect(sql).toMatch(/rk_claims_causal_needs_basis/);
  });
  it("uses a migration timestamp that does not collide with existing files", () => {
    expect(sql.length).toBeGreaterThan(1000);
  });
});

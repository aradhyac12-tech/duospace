/**
 * Knowledge snapshot = the ONLY knowledge production reasoning may see.
 * Versioned independently of app code (spec §34). Production snapshots contain
 * approved material only; nothing is ever deleted — superseded items stay in
 * the DB, they are simply not in a snapshot.
 */
import { KNOWLEDGE_VERSION, RULE_VERSION, TAXONOMY_VERSION, type EvidenceClaim, type ResearchSource, type Rule } from "./types";
import { SEED_CLAIMS } from "./seed/claims";
import { SEED_RULES } from "./seed/rules";
import { SEED_SOURCES } from "./seed/sources";

export interface KnowledgeSnapshot {
  knowledgeVersion: string; ruleVersion: string; taxonomyVersion: string;
  rules: readonly Rule[]; claims: readonly EvidenceClaim[]; sources: readonly ResearchSource[];
}

const sourceUsable = (s: ResearchSource | undefined): boolean =>
  !!s && s.reviewStatus === "approved" && s.identifiersVerified && s.retractionStatus !== "retracted";

/** A claim is executable only if approved AND backed by ≥1 usable (approved, verified, non-retracted) source. */
export function claimExecutable(c: EvidenceClaim, sources: readonly ResearchSource[]): boolean {
  if (c.reviewStatus !== "approved") return false;
  return c.sourceKeys.some((k) => sourceUsable(sources.find((s) => s.sourceKey === k)));
}

export function ruleExecutable(r: Rule, claims: readonly EvidenceClaim[], sources: readonly ResearchSource[]): boolean {
  if (r.status !== "approved") return false;
  return r.claimKeys.every((k) => { const c = claims.find((x) => x.claimKey === k); return !!c && claimExecutable(c, sources); });
}

/** What ships: everything in the seed, with its REAL review status (so, today, nothing executable beyond what a human approved). */
export function productionSnapshot(): KnowledgeSnapshot {
  return { knowledgeVersion: KNOWLEDGE_VERSION, ruleVersion: RULE_VERSION, taxonomyVersion: TAXONOMY_VERSION, rules: SEED_RULES, claims: SEED_CLAIMS, sources: SEED_SOURCES };
}

/**
 * TEST-ONLY. Marks every seed item approved/verified so the engine's logic can
 * be exercised. This does NOT mean any claim was reviewed; production code must
 * never call it (a test asserts productionSnapshot() has no executable rules).
 */
export function approveAllForTesting(snap: KnowledgeSnapshot = productionSnapshot()): KnowledgeSnapshot {
  return {
    ...snap,
    sources: snap.sources.map((s) => ({ ...s, reviewStatus: "approved", identifiersVerified: true, retractionStatus: "none_known" })),
    claims: snap.claims.map((c) => ({ ...c, reviewStatus: "approved" })),
    rules: snap.rules.map((r) => ({ ...r, status: "approved" })),
  };
}

/** Resolve rule → claims → sources for provenance (spec §8). */
export function provenanceFor(rule: Rule, snap: KnowledgeSnapshot): { claimKeys: string[]; sourceKeys: string[] } {
  const claims = rule.claimKeys.map((k) => snap.claims.find((c) => c.claimKey === k)).filter((c): c is EvidenceClaim => !!c);
  return { claimKeys: claims.map((c) => c.claimKey), sourceKeys: [...new Set(claims.flatMap((c) => c.sourceKeys))] };
}

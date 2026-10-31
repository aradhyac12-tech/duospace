/**
 * Ingestion pipeline (spec §22–24): DISCOVERY → DEDUPLICATION → METADATA →
 * VERIFICATION → CLASSIFICATION → EXTRACTION → LIMITATIONS → ASSESSMENT →
 * HUMAN REVIEW → APPROVAL → VERSIONED PUBLICATION.
 * This module is the state machine + gates. An imported paper can never reach
 * `approved` without a named human reviewer and the gate conditions below.
 */
import type { EvidenceClaim, ResearchSource, ReviewStatus } from "../types";
import type { CandidateSource } from "./types";

const NEXT: Record<ReviewStatus, readonly ReviewStatus[]> = {
  discovered: ["metadata_verified", "rejected"],
  metadata_verified: ["under_review", "rejected"],
  under_review: ["evidence_extracted", "rejected"],
  evidence_extracted: ["quality_assessed", "rejected"],
  quality_assessed: ["approved", "rejected"],
  approved: ["superseded", "retracted"],
  rejected: [],
  superseded: [],
  retracted: [],
};
export const canTransition = (from: ReviewStatus, to: ReviewStatus): boolean => NEXT[from].includes(to);

export interface TransitionRequest { to: ReviewStatus; reviewerId?: string | null; reason: string }
export interface Gate { ok: boolean; blockers: string[] }

export function gateSource(s: ResearchSource, req: TransitionRequest): Gate {
  const b: string[] = [];
  if (!canTransition(s.reviewStatus, req.to)) b.push(`illegal transition ${s.reviewStatus} → ${req.to}`);
  if (!req.reason.trim()) b.push("change reason required");
  if (req.to === "metadata_verified" && !(s.doi || s.pmid || s.pmcid || s.openalexId || s.semanticScholarId)) b.push("no canonical identifier");
  if (req.to === "approved") {
    if (!req.reviewerId) b.push("human reviewer required");
    if (!s.identifiersVerified) b.push("identifiers not verified against a registry");
    if (s.retractionStatus === "retracted") b.push("source is retracted");
    if (s.retractionStatus === "unknown") b.push("retraction status unchecked");
  }
  return { ok: b.length === 0, blockers: b };
}

export function gateClaim(c: EvidenceClaim, sources: readonly ResearchSource[], req: TransitionRequest): Gate {
  const b: string[] = [];
  if (!canTransition(c.reviewStatus, req.to)) b.push(`illegal transition ${c.reviewStatus} → ${req.to}`);
  if (!req.reason.trim()) b.push("change reason required");
  if (req.to === "approved") {
    if (!req.reviewerId) b.push("human reviewer required");
    if (c.sourceKeys.length === 0) b.push("no supporting source");
    if (!c.sourceKeys.some((k) => { const s = sources.find((x) => x.sourceKey === k); return !!s && s.reviewStatus === "approved" && s.identifiersVerified && s.retractionStatus !== "retracted"; })) b.push("no approved, verified, non-retracted source");
    if (c.limitations.length === 0) b.push("limitations missing");
    if (c.causalClaim && (c.associationType !== "experimental" || !c.causalBasis)) b.push("causal claim without experimental basis");
    if (c.certainty !== "unknown" && Object.keys(c.certaintyDimensions).length === 0) b.push("certainty stated without its reasons");
    if (c.gradeFormallyAssessed && c.certainty === "unknown") b.push("GRADE flagged but no certainty recorded");
  }
  return { ok: b.length === 0, blockers: b };
}

export function candidateToSource(c: CandidateSource, key: string): ResearchSource {
  return {
    sourceKey: key, sourceType: "journal_article", title: c.title, authors: c.authors, publication: c.publication, publicationYear: c.publicationYear,
    doi: c.doi ?? null, pmid: c.pmid ?? null, pmcid: c.pmcid ?? null, openalexId: c.openalexId ?? null, semanticScholarId: c.semanticScholarId ?? null,
    url: c.url ?? null, license: c.license ?? null,
    identifiersVerified: false, retractionStatus: c.retracted ? "retracted" : "unknown", reviewStatus: "discovered", version: 1,
  };
}

/** Retraction: demote claims whose ONLY usable support was this source. History retained. */
export function applyRetraction(sourceKey: string, claims: readonly EvidenceClaim[], sources: readonly ResearchSource[]): { sources: ResearchSource[]; claims: EvidenceClaim[]; demoted: string[] } {
  const ns = sources.map((s) => (s.sourceKey === sourceKey ? { ...s, retractionStatus: "retracted" as const, reviewStatus: "retracted" as const } : s));
  const demoted: string[] = [];
  const nc = claims.map((c) => {
    if (c.reviewStatus !== "approved" || !c.sourceKeys.includes(sourceKey)) return c;
    const stillOk = c.sourceKeys.some((k) => k !== sourceKey && ns.find((s) => s.sourceKey === k && s.reviewStatus === "approved" && s.retractionStatus !== "retracted"));
    if (stillOk) return c;
    demoted.push(c.claimKey);
    return { ...c, reviewStatus: "retracted" as const };
  });
  return { sources: ns, claims: nc, demoted };
}

/** Supersede, never delete: the old version stays queryable, the new one is linked and starts at `evidence_extracted`. */
export function supersedeClaim(old: EvidenceClaim, replacement: Omit<EvidenceClaim, "version" | "reviewStatus">): { old: EvidenceClaim; next: EvidenceClaim } {
  return { old: { ...old, reviewStatus: "superseded" }, next: { ...replacement, claimKey: old.claimKey, version: old.version + 1, reviewStatus: "evidence_extracted" } };
}

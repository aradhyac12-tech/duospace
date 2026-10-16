/**
 * Identifier-first deduplication (spec §3). Priority: DOI → PMID → PMCID →
 * OpenAlex → Semantic Scholar. Title similarity alone NEVER merges anything:
 * it can only raise a `possible_duplicate` flag for a human.
 */
import type { CandidateSource } from "./types";

export const normDoi = (d?: string | null): string | null => {
  if (!d) return null;
  const x = d.trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "").replace(/^doi:\s*/, "");
  return /^10\.\d{4,9}\/\S+$/.test(x) ? x : null;
};
export const normPmid = (p?: string | null): string | null => { const x = (p ?? "").trim().replace(/^pmid:?\s*/i, ""); return /^\d{1,9}$/.test(x) ? x : null; };
export const normPmcid = (p?: string | null): string | null => { const x = (p ?? "").trim().toUpperCase(); return /^PMC\d+$/.test(x) ? x : null; };
export const normOpenAlex = (o?: string | null): string | null => { const x = (o ?? "").trim().replace(/^https?:\/\/openalex\.org\//i, "").toUpperCase(); return /^W\d+$/.test(x) ? x : null; };
export const normS2 = (s?: string | null): string | null => { const x = (s ?? "").trim().toLowerCase(); return /^[0-9a-f]{40}$/.test(x) ? x : null; };

export interface IdSet { doi: string | null; pmid: string | null; pmcid: string | null; openalex: string | null; s2: string | null }
export const idsOf = (c: Pick<CandidateSource, "doi" | "pmid" | "pmcid" | "openalexId" | "semanticScholarId">): IdSet =>
  ({ doi: normDoi(c.doi), pmid: normPmid(c.pmid), pmcid: normPmcid(c.pmcid), openalex: normOpenAlex(c.openalexId), s2: normS2(c.semanticScholarId) });

export type DedupeResult =
  | { kind: "identifier_match"; matchedOn: keyof IdSet; index: number; conflicting: (keyof IdSet)[] }
  | { kind: "possible_duplicate"; index: number; reason: string }   // human review only
  | { kind: "new" };

const ORDER: (keyof IdSet)[] = ["doi", "pmid", "pmcid", "openalex", "s2"];
const tokens = (t: string) => new Set(t.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2));
const jaccard = (a: Set<string>, b: Set<string>) => { let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i || 1); };

export function findDuplicate(c: CandidateSource, existing: readonly CandidateSource[]): DedupeResult {
  const ci = idsOf(c);
  for (const key of ORDER) {
    const v = ci[key]; if (!v) continue;
    const index = existing.findIndex((e) => idsOf(e)[key] === v);
    if (index >= 0) {
      const ei = idsOf(existing[index]);
      // Two records sharing one id but disagreeing on another strong id is suspicious → flag, don't silently merge.
      const conflicting = ORDER.filter((k) => k !== key && ci[k] && ei[k] && ci[k] !== ei[k]);
      return { kind: "identifier_match", matchedOn: key, index, conflicting };
    }
  }
  // No shared identifier. If BOTH carry a DOI and they differ they are different works (e.g. preprint vs article).
  const ct = tokens(c.title);
  for (let index = 0; index < existing.length; index++) {
    const e = existing[index]; const ei = idsOf(e);
    if (ci.doi && ei.doi && ci.doi !== ei.doi) continue;
    if (c.publicationYear && e.publicationYear && Math.abs(c.publicationYear - e.publicationYear) > 1) continue;
    if (jaccard(ct, tokens(e.title)) >= 0.85) return { kind: "possible_duplicate", index, reason: "very similar title, no shared identifier" };
  }
  return { kind: "new" };
}

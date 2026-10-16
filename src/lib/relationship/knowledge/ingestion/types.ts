/** Replaceable discovery adapters (spec §3). The reasoning engine never imports these. */
import type { ResearchSource } from "../types";

export type AdapterId = "pubmed" | "pmc" | "openalex" | "semantic_scholar" | "crossref" | "datacite" | "orcid" | "static";

export interface CandidateSource {
  adapter: AdapterId;
  title: string; authors: { name: string; orcid?: string }[]; publication: string | null; publicationYear: number | null;
  doi?: string | null; pmid?: string | null; pmcid?: string | null; openalexId?: string | null; semanticScholarId?: string | null;
  dataciteDoi?: string | null; url?: string | null; license?: string | null;
  abstractAvailable?: boolean; openAccess?: boolean; retracted?: boolean;
}
export interface SearchQuery { text: string; studyTypes?: ("systematic_review" | "meta_analysis" | "primary")[]; fromYear?: number; limit?: number }

export interface SourceAdapter {
  readonly id: AdapterId;
  search(q: SearchQuery): Promise<CandidateSource[]>;
  /** Look up one record by a canonical identifier (used for verification and retraction checks). */
  lookup(idKind: "doi" | "pmid" | "pmcid" | "openalex" | "s2", id: string): Promise<CandidateSource | null>;
}

export class AdapterRegistry {
  private m = new Map<AdapterId, SourceAdapter>();
  register(a: SourceAdapter): this { this.m.set(a.id, a); return this; }
  get(id: AdapterId): SourceAdapter | undefined { return this.m.get(id); }
  all(): SourceAdapter[] { return [...this.m.values()]; }
  /** One failing provider never breaks discovery. */
  async searchAll(q: SearchQuery): Promise<{ results: CandidateSource[]; failed: AdapterId[] }> {
    const results: CandidateSource[] = []; const failed: AdapterId[] = [];
    await Promise.all(this.all().map(async (a) => { try { results.push(...await a.search(q)); } catch { failed.push(a.id); } }));
    return { results, failed };
  }
}

/** In-memory adapter for tests and offline dev. Real adapters are NOT implemented in this phase. */
export class StaticAdapter implements SourceAdapter {
  readonly id = "static" as const;
  private readonly records: CandidateSource[];
  constructor(records: CandidateSource[]) { this.records = records; }
  async search(q: SearchQuery) { const t = q.text.toLowerCase(); return this.records.filter((r) => r.title.toLowerCase().includes(t)).slice(0, q.limit ?? 20); }
  async lookup(kind: "doi" | "pmid" | "pmcid" | "openalex" | "s2", id: string) {
    const f = kind === "doi" ? "doi" : kind === "pmid" ? "pmid" : kind === "pmcid" ? "pmcid" : kind === "openalex" ? "openalexId" : "semanticScholarId";
    return this.records.find((r) => String((r as unknown as Record<string, unknown>)[f] ?? "").toLowerCase() === id.toLowerCase()) ?? null;
  }
}
export type { ResearchSource };

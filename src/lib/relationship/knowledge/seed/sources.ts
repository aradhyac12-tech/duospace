/**
 * Initial source seed. SMALL ON PURPOSE.
 *
 * Records were first written from memory, then cross-checked on 2026-10-04 via
 * web search against publisher / PubMed / PMC / library / university pages and
 * independent bibliographies. Only the Woodin record was matched on a PubMed
 * record itself (PMID + DOI shown together), so only it has
 * `identifiersVerified: true`. The rest await a registry (Crossref/PubMed)
 * lookup or human check; the DB trigger rk_guard_claim_approval requires
 * `identifiers_verified` before a claim can be approved.
 *
 * `reviewStatus`:
 *   "metadata_verified" = bibliographic details matched ≥2 independent pages
 *   "discovered"        = found but not (fully) checked — do not rely on it
 * Retraction status is `unknown` for all: no retraction check has been run.
 * Identifiers are only included where confirmed; otherwise null.
 */
import type { ResearchSource } from "../types";

const base = {
  pmid: null, pmcid: null, openalexId: null, semanticScholarId: null, url: null, license: null,
  identifiersVerified: false, retractionStatus: "unknown" as const, reviewStatus: "discovered" as const, version: 1,
};
const MV = { reviewStatus: "metadata_verified" as const };
const X = "Cross-checked 2026-10-04 on secondary pages; registry (Crossref/PubMed) lookup pending.";

export const SEED_SOURCES: readonly ResearchSource[] = [
  { ...base, ...MV, sourceKey: "funk-rogge-2007", sourceType: "journal_article", title: "Testing the ruler with item response theory: increasing precision of measurement for relationship satisfaction with the Couples Satisfaction Index", authors: [{ name: "Funk, J. L." }, { name: "Rogge, R. D." }], publication: "Journal of Family Psychology", publicationYear: 2007, doi: "10.1037/0893-3200.21.4.572", note: `Couples Satisfaction Index; 21(4), 572-583. ${X}` },
  { ...base, ...MV, sourceKey: "hendrick-1988", sourceType: "journal_article", title: "A generic measure of relationship satisfaction", authors: [{ name: "Hendrick, S. S." }], publication: "Journal of Marriage and the Family", publicationYear: 1988, doi: "10.2307/352430", note: `Relationship Assessment Scale; 50(1), 93-98. ${X}` },
  { ...base, ...MV, sourceKey: "spanier-1976", sourceType: "journal_article", title: "Measuring dyadic adjustment: new scales for assessing the quality of marriage and similar dyads", authors: [{ name: "Spanier, G. B." }], publication: "Journal of Marriage and the Family", publicationYear: 1976, doi: "10.2307/350547", note: `Dyadic Adjustment Scale; 38(1), 15-28. ${X}` },
  { ...base, ...MV, sourceKey: "karney-bradbury-1995", sourceType: "journal_article", title: "The longitudinal course of marital quality and stability: a review of theory, method, and research", authors: [{ name: "Karney, B. R." }, { name: "Bradbury, T. N." }], publication: "Psychological Bulletin", publicationYear: 1995, doi: "10.1037/0033-2909.118.1.3", note: `118(1), 3-34. Review of 115 longitudinal studies (over 45,000 marriages) on how marital quality and stability change over time. Its abstract does NOT address communication, so it is not used for communication claims. ${X}` },
  { ...base, ...MV, sourceKey: "woodin-2011-conflict-meta", sourceType: "meta_analysis", title: "A two-dimensional approach to relationship conflict: meta-analytic findings", authors: [{ name: "Woodin, E. M." }], publication: "Journal of Family Psychology", publicationYear: 2011, doi: "10.1037/a0023791", pmid: "21553964", identifiersVerified: true,
    note: "25(3), 325-335. Matched on the PubMed record (PMID and DOI shown together) 2026-10-04, plus APA supplemental page and a Wiley reference list. Abstract read; full text not read. Retraction status not checked." },
  { ...base, ...MV, sourceKey: "kanter-2022-communication-meta", sourceType: "meta_analysis", title: "Does couple communication predict later relationship quality and dissolution? A meta-analysis", authors: [{ name: "Kanter et al. (full author list not retrieved)" }], publication: "Journal of Marriage and Family", publicationYear: 2022, doi: "10.1111/jomf.12804",
    note: "Title and DOI seen on the Wiley abstract page and quoted in another source; author list, volume and pages not retrieved. Abstract read; full text not read." },
  { ...base, ...MV, sourceKey: "gable-et-al-2004", sourceType: "journal_article", title: "What do you do when things go right? The intrapersonal and interpersonal benefits of sharing positive events", authors: [{ name: "Gable, S. L." }, { name: "Reis, H. T." }, { name: "Impett, E. A." }, { name: "Asher, E. R." }], publication: "Journal of Personality and Social Psychology", publicationYear: 2004, doi: "10.1037/0022-3514.87.2.228", pmid: "15301629", note: `87(2), 228-245. DOI printed on the article's own title page; PMID from PubPeer. Abstract read. ${X}` },
  { ...base, ...MV, sourceKey: "reis-clark-holmes-2004", sourceType: "book_chapter", title: "Perceived partner responsiveness as an organizing construct in the study of intimacy and closeness", authors: [{ name: "Reis, H. T." }, { name: "Clark, M. S." }, { name: "Holmes, J. G." }], publication: "Handbook of Closeness and Intimacy (Mashek & Aron, eds.), Lawrence Erlbaum, ch. 12, pp. 201-225", publicationYear: 2004, doi: null, note: "Chapter's existence and citation matched on several bibliographies and the book's contents list. The wording of the responsiveness definition in CLM-PPR-CONSTRUCT has NOT been checked against the chapter text." },
  { ...base, ...MV, sourceKey: "rusbult-martz-agnew-1998", sourceType: "journal_article", title: "The Investment Model Scale: measuring commitment level, satisfaction level, quality of alternatives, and investment size", authors: [{ name: "Rusbult, C. E." }, { name: "Martz, J. M." }, { name: "Agnew, C. R." }], publication: "Personal Relationships", publicationYear: 1998, doi: "10.1111/j.1475-6811.1998.tb00177.x", note: `5(4). Page range differs between sources (357-387 vs 357-391; the article itself prints 357-391). Scale-validation paper; the model itself comes from earlier work (Rusbult 1980, 1983). ${X}` },
  { ...base, ...MV, sourceKey: "mokkink-cosmin-2010", sourceType: "journal_article", title: "The COSMIN checklist for assessing the methodological quality of studies on measurement properties of health status measurement instruments: an international Delphi study", authors: [{ name: "Mokkink, L. B." }, { name: "Terwee, C. B." }, { name: "Patrick, D. L." }, { name: "Alonso, J." }, { name: "Stratford, P. W." }, { name: "Knol, D. L." }, { name: "Bouter, L. M." }, { name: "de Vet, H. C. W." }], publication: "Quality of Life Research", publicationYear: 2010, doi: "10.1007/s11136-010-9606-8", pmcid: "PMC2852520", note: `19(4), 539-549. Built for health-related patient-reported outcomes; use for relationship measures is by analogy. ${X}` },
  { ...base, ...MV, sourceKey: "cdc-ipv-definitions-2015", sourceType: "agency_report", title: "Intimate Partner Violence Surveillance: Uniform Definitions and Recommended Data Elements, Version 2.0", authors: [{ name: "Breiding, M. J." }, { name: "Basile, K. C." }, { name: "Smith, S. G." }, { name: "Black, M. C." }, { name: "Mahendra, R. R." }], publication: "Centers for Disease Control and Prevention, National Center for Injury Prevention and Control", publicationYear: 2015, doi: null, url: "https://stacks.cdc.gov/view/cdc/31292", note: `Defines IPV as physical violence, sexual violence, stalking and psychological aggression (including coercive tactics) by a current or former intimate partner. Surveillance definitions, not response guidance. ${X}` },
  { ...base, ...MV, sourceKey: "who-ipv-2012", sourceType: "guideline", title: "Understanding and addressing violence against women: intimate partner violence", authors: [{ name: "World Health Organization" }, { name: "Pan American Health Organization" }], publication: "WHO information sheet, reference WHO/RHR/12.36", publicationYear: 2012, doi: null, note: "12-page information sheet; overview describes IPV as including physical, sexual and emotional abuse and controlling behaviours. Matched on a WHO-series listing; WHO-hosted page not fetched." },
  { ...base, sourceKey: "who-responding-2013", sourceType: "guideline", title: "Responding to intimate partner violence and sexual violence against women: WHO clinical and policy guidelines", authors: [{ name: "World Health Organization" }], publication: "WHO", publicationYear: 2013, doi: null,
    note: "Existence suggested by a UN inventory entry (finalised 2012, published 2013). Title, year and any passage NOT checked against WHO. Candidate support for the 'separate response framework' claim." },
];

# Research methodology

## Discovery (PRISMA-S-inspired)
Automated discovery is designed for PubMed/NCBI E-utilities, PubMed Central, OpenAlex, Semantic Scholar and Crossref
(DataCite and ORCID for identifiers/authors). Systematic reviews and meta-analyses are searched first. Every search
(provider, query string, date, filters, result counts) must be logged so a search can be re-run. **Adapters are interfaces
only in this phase** (`ingestion/types.ts`); an in-memory `StaticAdapter` exists for tests. No provider was contacted while
building this phase (no network).

## What counts as evidence
Allowed: peer-reviewed articles, systematic reviews/meta-analyses, validated-instrument manuals, WHO/CDC and comparable
authoritative bodies (for safety). **Not allowed as scientific evidence**: TikTok, Reddit, Quora, blogs, relationship
influencers, unverified AI output. They may inform product research only. An LLM summary is never a source
(`rk_findings.extracted_by` is `human` or `human_verified_assist`).

## Appraisal
- **Measurement instruments**: COSMIN-style appraisal (reliability, validity, invariance, responsiveness) → `rk_instruments`.
  Instruments are research assets; `user_facing_authorized` is `false` and there is no UI path.
- **Certainty of claims**: GRADE-*inspired* dimensions (study quality, design, sample size, replication, consistency,
  directness, precision, risk of bias, publication bias, population fit, temporal evidence) with a plain label
  `very_low | low | moderate | high | unknown`. A label other than `unknown` must carry its dimensions (DB check +
  pipeline gate). `grade_formally_assessed` stays `false` unless a formal assessment truly happened.
- **Association ≠ causation**: `causal_claim` requires `association_type = experimental` and a written `causal_basis`
  (DB check + gate). All seed claims are non-causal.

## Copyright
Only bibliographic metadata, identifiers, links and short attributed paraphrases are stored. `full_text_stored` may be true
only when `license` is present (DB check).

## Seed provenance and verification log

The seed was first written offline from memory, then cross-checked on **2026-10-04** with web search against publisher,
PubMed / PubMed Central, library and university pages and independent bibliographies. Only the Woodin record was matched on a
PubMed record itself (PMID and DOI together), so only it has `identifiersVerified:true`. Everything else still needs a
Crossref/PubMed lookup or a human check, and **no retraction check has been run on any source**. The database refuses claim
approval until a source is approved, identifier-verified and not retracted.

| Source | What was confirmed | Status |
|---|---|---|
| Funk & Rogge 2007 (CSI), J Fam Psychol 21(4) 572–583 | title, journal, pages, year, DOI (many pages) | `metadata_verified` |
| Hendrick 1988 (RAS), J Marriage Fam 50(1) 93–98 | incl. DOI | `metadata_verified` |
| Spanier 1976 (DAS), J Marriage Fam 38(1) 15–28 | incl. DOI | `metadata_verified` |
| Karney & Bradbury 1995, Psychol Bull 118(1) 3–34 | incl. DOI; abstract is about **change over time**, **not communication** | `metadata_verified` |
| Woodin 2011, J Fam Psychol 25(3) 325–335 | **PubMed record**: PMID 21553964, DOI 10.1037/a0023791; abstract read | `metadata_verified`, identifiers verified |
| Kanter et al. 2022, J Marriage Fam (communication → later quality/dissolution) | title + DOI 10.1111/jomf.12804 on Wiley page; authors/volume/pages not retrieved | `metadata_verified` |
| Gable et al. 2004, JPSP 87(2) 228–245 | DOI on the article's own title page; PMID 15301629; abstract read | `metadata_verified` |
| Reis, Clark & Holmes 2004, chapter 12 of *Handbook of Closeness and Intimacy*, pp. 201–225 | citation + contents list; no DOI; **definition wording not checked against text** | `metadata_verified` (claim stays `discovered`) |
| Rusbult, Martz & Agnew 1998, Personal Relationships 5(4) | DOI 10.1111/j.1475-6811.1998.tb00177.x; abstract read; pages differ across sources (357–387 vs 357–391) | `metadata_verified` |
| Mokkink et al. 2010 (COSMIN), Qual Life Res 19(4) 539–549 | incl. DOI, PMC2852520; built for health patient-reported outcomes | `metadata_verified` |
| CDC IPV Uniform Definitions v2.0 (2015) | exists; IPV = physical, sexual, stalking, psychological aggression incl. coercive tactics | `metadata_verified` |
| WHO 2012 information sheet, WHO/RHR/12.36 | 12-page sheet confirmed via a WHO-series listing | `metadata_verified` |
| WHO clinical and policy guidelines on responding to IPV/SVAW (2013) | only a UN-inventory mention; title/year unchecked | `discovered` |

### What verification changed
- **Corrected:** `CLM-COMM-ASSOC` first cited Karney & Bradbury for "communication is associated with satisfaction"; that
  abstract doesn't address communication. It now rests on Woodin (observed conflict behaviours ↔ satisfaction, correlates only).
- **Added:** `CLM-COMM-LONGITUDINAL` (Kanter 2022: positive/negative communication → small associations with *later* quality;
  negative communication ↔ later dissolution; still observational, not causal) and `CLM-LONGITUDINAL-CHANGE`
  (relationships change over time; supports time-sensitivity in general, **not** the specific staleness thresholds).
- **Tightened:** `CLM-CAPITALIZATION` follows the abstract; `CLM-IPV-DEFINITION` includes "coercive tactics".
- **Held at `discovered`:** `CLM-PPR-CONSTRUCT` (definition wording unchecked) and `CLM-IPV-SEPARATE-FRAMEWORK` (no guideline
  passage located; it is closer to product policy than a research finding).
- **Invariant (tested):** a claim is never further along than its weakest source.

Everything remains `certainty:"unknown"`, with no effect sizes of our own, no thresholds, and nothing `approved`. Claims
evidenced only by abstracts say so in their limitations.

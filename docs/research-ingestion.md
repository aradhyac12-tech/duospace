# Research ingestion

```
DISCOVERY → DEDUPLICATION → METADATA NORMALIZATION → SOURCE VERIFICATION → STUDY CLASSIFICATION →
CONSTRUCT EXTRACTION → FINDING EXTRACTION → LIMITATION EXTRACTION → EVIDENCE ASSESSMENT →
HUMAN REVIEW → KNOWLEDGE APPROVAL → VERSIONED PUBLICATION
```
An imported paper never becomes executable by itself.

## Review status
`discovered → metadata_verified → under_review → evidence_extracted → quality_assessed → approved`; terminal/other:
`rejected`, `superseded`, `retracted`. Stages cannot be skipped (`canTransition`). Only `approved` is used by production
reasoning.

## Gates (`ingestion/pipeline.ts`, mirrored by DB triggers)
- Source → `approved`: named human reviewer, identifiers verified against a registry, retraction status known and not
  retracted, reason recorded.
- Claim → `approved`: reviewer, ≥1 approved + verified + non-retracted source, limitations present, causal claims need an
  experimental basis, any certainty label needs its dimensions.

## Deduplication (`ingestion/dedupe.ts`)
Identifier-first: DOI → PMID → PMCID → OpenAlex → Semantic Scholar. Title similarity alone **never** merges — it can only
raise `possible_duplicate` for a human; two different DOIs with the same title are different works; conflicting secondary
identifiers on an identifier match are flagged.

## Retraction / updates
`applyRetraction` (and DB trigger `rk_on_source_retracted`) demote claims whose only usable support was the source;
multi-source claims survive. `supersedeClaim` keeps the old version (`superseded`) and creates a linked new version at
`evidence_extracted`. Nothing is deleted.

## Adapters
`SourceAdapter { search, lookup }` + `AdapterRegistry` (one failing provider doesn't break discovery). Real PubMed/PMC/
OpenAlex/Semantic Scholar/Crossref/DataCite/ORCID adapters are **not implemented** (response shapes could not be verified
offline); the engine does not import adapters.

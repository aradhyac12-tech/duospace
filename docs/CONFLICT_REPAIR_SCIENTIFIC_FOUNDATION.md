# Conflict Repair — Scientific Foundation (Phase 3C)

**DuoSpace has no evidence that this feature improves relationships.** This document separates what research says from what DuoSpace merely assumes. Sources S1–S9 and their verification levels are defined in `docs/AI_SCIENTIFIC_FOUNDATION.md` and `docs/RESPONSIVENESS_SCIENTIFIC_FOUNDATION.md`.

## New source

| # | Source | Type | Verification |
|---|---|---|---|
| S10 | Fehr, R., Gelfand, M. J., & Nag, M. (2010). The road to forgiveness: A meta-analytic synthesis of its situational and dispositional correlates. *Psychological Bulletin, 136*(5), 894–914. doi:10.1037/a0019993 | Meta-analysis, 175 studies, 26,006 participants | Abstract (publisher + author PDF), 2026-09-25 |
| S11 | Luchies, L. B., Finkel, E. J., McNulty, J. K., & Kumashiro, M. (2010). The doormat effect: forgiveness can erode self-respect/self-concept when the offender does not make amends. *J. Personality and Social Psychology.* | Empirical studies | **Citation only** (seen described in a peer-reviewed article; not read) — not relied on |

## A. Established constructs
Acknowledgment and validation (the "understanding/validation" facets of perceived partner responsiveness, S1–S3, S9); responsibility/apology; perspective-taking; specific requests; clarification. These are well-defined constructs in the literature.

## B. Findings from research (what they do and do not show)
- **Apology and empathy correlate with forgiveness.** S10 reports, across 175 studies, that apology (r ≈ .42), state empathy (r ≈ .51) and lower perceived intent to harm (r ≈ −.49) correlate with interpersonal forgiveness. *Limits:* correlational; mostly single-offender/single-victim transgressions, not specifically romantic couples; many scenario/recall designs (S10 notes methodology moderated some effects). It does **not** show that an app-drafted apology produces forgiveness.
- **Responsiveness is associated with intimacy** (S2, S3; correlational diary studies).
- **Relationship-education programmes** show modest improvements in communication and relationship quality in experimental studies (S4, S5) — facilitator-led, multi-hour programmes, not apps.

## C. Product hypotheses (untested)
- Separating fact / experience / interpretation / unknown before speaking reduces avoidable misunderstanding.
- Asking a non-leading question instead of asserting a motive reduces defensiveness.
- Behaviour-specific responsibility ("I raised my voice") is easier to hear than global self- or partner-blame.
- Preserving disagreement and boundaries avoids "repair = surrender", which S11 (citation only) suggests can have costs.

## D. Unvalidated DuoSpace features
The 12-stage flow, the message components, the globalising-language suggestions, the edit chips and the safety gate's pattern lists are **engineering designs**, not validated instruments. The safety gate's detection accuracy in real use is unknown (see §E).

## E. Outcomes that would require human evaluation
Perceived partner responsiveness, perceived understanding, communication quality, conflict recovery, repair effectiveness, relationship satisfaction, user autonomy; adverse outcomes (escalation, coercion risk, harm from a shared message); acceptability; privacy incidents; **safety-gate false positives and false negatives in real use**. See `docs/DYADIC_AI_EVALUATION_PLAN.md` — to be extended with: primary outcome = perceived understanding after a repair conversation; adverse outcomes = escalation or coercion reports; safety-gate error rates measured against human review. **No such data exists.**

## Design decisions derived from the evidence (and its limits)
- Apology is **optional and explicit** — S10 is correlational and cannot justify pushing apologies; forced apologies also conflict with preserving the user's position.
- No forgiveness prompts, no "you should forgive", no reconciliation pressure.
- Safety first: when the text suggests danger or coercion, no couples-style repair is offered at all. Relationship-education and responsiveness research concerns ordinary conflict, not abuse; applying it there could cause harm.

## DuoSpace must not claim
That this feature repairs relationships, increases forgiveness, reduces conflict, or detects abuse. Permitted wording: "One possible way to say what you know and what you still want to understand."

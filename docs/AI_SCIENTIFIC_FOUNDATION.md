# DuoSpace AI — Scientific Foundation (Phase 3A)

Canonical principle: **DuoSpace AI facilitates evidence-grounded mutual understanding, responsiveness, constructive communication and repair. It does not judge partners or predict relationship outcomes.**

## How sources were checked

Each source below was located on 2026-09-25 and its bibliographic details and abstract checked against the publisher page, an author-institution repository, or a PubMed-indexed record. **Verification level** says exactly what was read:

- **Abstract** — the abstract / publisher summary was read.
- **Citation only** — the reference was confirmed in the reference lists of other peer-reviewed papers; the paper itself was not read in this phase.

Nothing in this document is based on influencer content, pop-psychology tests or unsourced claims. Where a claim needs a source we could not verify, it is not made.

## Sources

| # | Source | Type | Verification |
|---|---|---|---|
| S1 | Reis, H. T., & Shaver, P. (1988). Intimacy as an interpersonal process. In S. Duck (Ed.), *Handbook of personal relationships*. | Theory (book chapter) | Citation only (as described in S2's abstract) |
| S2 | Laurenceau, J.-P., Barrett, L. F., & Pietromonaco, P. R. (1998). Intimacy as an interpersonal process: The importance of self-disclosure, partner disclosure, and perceived partner responsiveness in interpersonal exchanges. *J. Personality and Social Psychology, 74*(5), 1238–1251. | Two event-contingent diary studies | Abstract |
| S3 | Laurenceau, J.-P., Barrett, L. F., & Rovine, M. J. (2005). The interpersonal process model of intimacy in marriage: A daily-diary and multilevel modeling approach. *J. Family Psychology, 19*(2), 314–323. | 42-day diary, 96 married couples | Abstract |
| S4 | Hawkins, A. J., Blanchard, V. L., Baldwin, S. A., & Fawcett, E. B. (2008). Does marriage and relationship education work? A meta-analytic study. *J. Consulting and Clinical Psychology, 76*(5), 723–734. | Meta-analysis (117 studies) | Abstract |
| S5 | Blanchard, V. L., Hawkins, A. J., Baldwin, S. A., & Fawcett, E. B. (2009). Investigating the effects of marriage and relationship education on couples' communication skills: A meta-analytic study. *J. Family Psychology, 23*(2), 203–214. | Meta-analysis (143 studies) | Abstract |
| S6 | Fawcett, E. B., Hawkins, A. J., Blanchard, V. L., & Carroll, J. S. (2010). Do premarital education programs really work? A meta-analytic study. *Family Relations, 59*(3), 232–239. | Meta-analysis | Citation only |
| S7 | Halford, W. K., & Bodenmann, G. (2013). Effects of relationship education on maintenance of couple relationship satisfaction. *Clinical Psychology Review, 33*(4), 512–525. | Review | Citation only |
| S8 | Falconier, M. K., Jackson, J. B., Hilpert, P., & Bodenmann, G. (2015). Dyadic coping and relationship satisfaction: A meta-analysis. *Clinical Psychology Review, 42*, 28–46. | Meta-analysis | Citation only |

S6–S8 are listed for completeness because they are central to the field. **No design decision in Phase 3A depends on a claim taken only from S6–S8.** They must be read before any Phase 3B design relies on them.

## Intervention principles

### P1. Perceived partner responsiveness (PPR)

- **Construct:** the perception that one's partner understands, validates and cares about what one has disclosed (S1, as operationalised in S2/S3).
- **Operational definition in DuoSpace:** the Reply helper asks five questions about the user's *own* draft (did I understand, acknowledge, respond to the request, avoid jumping to advice, share my own view respectfully). It flags features of the draft; it never rates the partner.
- **Supporting evidence:** S2 found that self-disclosure, partner disclosure and perceived responsiveness contributed to momentary intimacy in diary reports; S3 found in 96 married couples over 42 days that self- and partner disclosure predicted daily intimacy and that PPR **partially mediated** those effects.
- **Population:** S2 — mainly undergraduate students, all social interactions (not only romantic); S3 — married couples in one US sample.
- **Limitations:** correlational, within-person diary designs; self-report; they show association with *same-day* intimacy, not that an app prompt changes responsiveness or intimacy. Cultural generality is not established by these studies.
- **DuoSpace may claim:** "Research on intimacy links feeling understood, validated and cared for by a partner with feeling close in everyday interactions. This tool helps you check whether your reply shows those things."
- **DuoSpace must NOT claim:** that using the Reply helper increases intimacy, satisfaction or responsiveness; that a flagged draft is "unresponsive" in fact; anything about the partner's perception.

### P2. Communication-skills education

- **Construct:** structured teaching of communication and problem-solving skills to couples (marriage and relationship education, MRE).
- **Operational definition in DuoSpace:** neutral, specific conversation prompts attached to each area; separating "what was said" from interpretation; offering several hedged possibilities instead of one.
- **Supporting evidence:** S4 — in experimental studies, MRE was associated with modest improvements in relationship quality (d ≈ 0.30–0.36) and communication skills (d ≈ 0.43–0.45); moderate-dose programmes did better than low-dose. S5 — modest evidence MRE improves communication skills; effects were larger on observational than self-report measures, and at longer follow-ups for more distressed couples.
- **Population:** predominantly US, predominantly married or engaged, largely middle-income and white samples in the underlying trials.
- **Limitations:** these are facilitator-led, multi-hour **programmes**, not apps; effects are modest; published studies showed larger communication effects than unpublished ones at follow-up (possible publication bias, S4); none of this evidence concerns AI-generated prompts.
- **DuoSpace may claim:** "Structured communication education for couples has shown modest benefits in research. DuoSpace borrows the idea of neutral, specific conversation starters."
- **DuoSpace must NOT claim:** that DuoSpace is relationship education, that it improves relationship quality, or any effect size.

### P3. Difference ≠ incompatibility; agreement ≠ quality

- **Construct / rule:** a deterministic comparison reports ALIGNED / DIFFERENT / UNKNOWN per item and never aggregates.
- **Evidence status:** this is a **design safeguard**, not an empirical claim. None of S1–S8 validates a "compatibility" measure derived from preference questionnaires, and DuoSpace has no validated instrument that could support one. Reporting a score would imply predictive validity that does not exist.
- **DuoSpace must NOT claim:** compatibility, relationship health, outcome prediction, or that differences cause problems.

### P4. Uncertainty and grounding

- **Rule:** every statement about a person must trace to something that person explicitly stated; unknowns are always shown; staleness is surfaced.
- **Evidence status:** a product-integrity requirement (avoiding fabrication and over-interpretation), not a psychological finding. It is enforced by code (see `.ai/DYADIC_AI_SPEC.md`), not argued from literature.

## What is explicitly out of scope

Attachment-style inference, personality typing, diagnosis, cheating/lie detection, multimodal (face/voice) emotion inference, and outcome prediction. None is supported by the evidence above for use by an app, and several carry clear risk of harm.

## Open items

1. Read S6–S8 in full before relying on them.
2. Look for evidence specific to **digitally delivered** couple interventions before claiming anything about app-based delivery.
3. Select validated outcome instruments for `docs/DYADIC_AI_EVALUATION_PLAN.md` from primary validation papers (not yet done).

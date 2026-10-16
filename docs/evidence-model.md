# Evidence model

## Observation (private, per relationship)
`observer → subject → target`, `construct.attribute = value`, `source_type`, `evidence_tier`, `confidence`, `explicitness`,
`temporal_scope`, `perspective`, `confirmation_status`, validity window, `observed_at`, `last_confirmed_at`.
Values are structured — **never raw message text**.

Perspective: `A_to_A`, `A_to_B`, `B_to_A`, `B_to_B`, `dyad`. What A says about B is **not** B's statement.

## Tiers (authority, high → low)
| Tier | Meaning |
|---|---|
| `mutually_confirmed` | subject's own statement + a confirmed partner report that agrees |
| `explicit_self_report` | the subject said it about themself |
| `confirmed_partner_report` | A reported about B and B confirmed |
| `observed_pattern` | derived from behaviour patterns |
| `unconfirmed_partner_report` | A said it about B; B hasn't confirmed |
| `inferred` | extracted/guessed (e.g. by language analysis) |

The tier is **re-derived** from source facts (`deriveTier`), so a mislabelled stored tier cannot promote an inference.
The DB also forbids `inferred` rows being explicit. Promotion = a **new** observation created by the user's confirmation
(`confirmDraft`); statements about the partner can only ever become partner reports.

## Evidence states
`known · reported · confirmed · observed · inferred · unknown · contradictory · stale`. Unknown is never coerced.

## Resolution rules (`resolveFact`)
1. Withdrawn/disputed statements are ignored.
2. Stale evidence is kept as history but returns `stale` (confidence 0).
3. Per (observer, tier) the newest statement wins (people change their minds); two different statements at the same
   instant are `contradictory`.
4. Highest tier wins; equal-tier disagreement → `contradictory` (never averaged).
5. A partner's differing report is exposed as `discrepantPartnerReport` — surfaced, not merged.

## Temporal model
`stale` if: past `valid_until`/`expires_at`, described as historical, or not reconfirmed within the construct's threshold
(communication preferences 180 d, relationship direction 60 d, life stress 90 d, default 365 d, safety ~10 y and never
auto-cleared). Confidence decays exponentially (half-life = threshold). **These are engineering parameters, not
research-derived**; they are the first thing to tune with real data and expert input.

## Dyadic modelling
APIM is a *conceptual* reference (actor/partner effects). No APIM parameters are estimated; no statistics are run.

## Confidence labels
`unknown | low | moderate | high` = the minimum of (rule cap, tier cap, decayed numeric confidence band). Tier caps:
self/mutual → high, confirmed partner/observed → moderate, unconfirmed partner/inferred → low. Current rules cap at
moderate. Bands (0.4 / 0.7) are engineering heuristics.

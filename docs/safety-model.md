# Safety model

Safety rules outrank relationship optimisation. DuoSpace **does not diagnose** abuse and does not assess anyone's safety;
the states describe how strongly a concern has been *reported*.

| State | Requirement (product policy — see caveat) |
|---|---|
| `none` | no indicators |
| `possible_safety_concern` | a single weaker indicator, or any indicator that is not a first-person report |
| `reported_safety_concern` | first-person report of a strong behaviour (violence, sexual coercion, threat, stalking, weapon, threat to children/pets), or ≥2 distinct coercive-control indicators, or 1 + stated fear |
| `confirmed_safety_concern` | reported **and** confirmed by the reporter when asked (not external verification) |
| `urgent_safety_concern` | first-person imminent danger |

Indicators: physical violence, sexual coercion, threats, stalking, monitoring, anger at friend contact, isolation, financial
control, repeated intimidation, psychological aggression, blackmail, fear for safety, imminent danger.

## Behaviour when any concern exists
- Ordinary insights/advice are **withheld** (not just outranked).
- `jointConfrontationAllowed = false` — never suggest talking it through together or confronting.
- `shareWithPartner = false` — the partner may be the source of danger; nothing is shared.
- Adaptive questions stop.
- Old reports do not decay into "resolved"; they may flag `needsReconfirmation`. A reporter can withdraw a statement.
- Fail-closed: a failed text check yields a concern, via the existing `checkSafety`.

## Text → signals
`normalize.ts` reuses the existing English `checkSafety` and Indian-language `multilingualSafetyCategories`, plus one
added pattern ("gets angry when I talk to friends"). *"He checks my phone and gets angry if I talk to friends"* → monitoring
+ anger-at-friend-contact → `reported_safety_concern`, not communication advice. *"I need some space"* → `none`.

## Localised guidance
`localizedSafetyGuidance` (existing reviewed copy; names the emergency number only for device region IN, otherwise neutral).
No new helpline table was added because numbers could not be verified offline.

## Caveats
Thresholds are product policy chosen to err toward offering support. **They need review by a domestic-violence advocate or
clinician before launch**, and the multilingual lexicon (inherited) was written without native-speaker review.

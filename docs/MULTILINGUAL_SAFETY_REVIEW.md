# Multilingual Safety Review (2026-09-25)

**Native-speaker review has NOT happened for any non-English language.** Every language below is `NOT_REVIEWED`. Passing tests prove the code matches its own lexicon — not that the lexicon covers how people really write.

Measured on self-authored probes (`docs/eval/multilingual_safety_probe.json`). The probes were written by the same author as the lexicon, and the two misses found were then fixed on the same probes, so the numbers below **overstate** real coverage. They are a regression floor, not an accuracy estimate.

| Language | Lexicon phrases | Probe detection | Benign false positives | Main known limitations | Translation confidence | Native review |
|---|---|---|---|---|---|---|
| English | pattern rules (Phase 3C) | 3/3 | 0/3 | idioms, sarcasm, indirect threats | — | n/a |
| हिन्दी (hi) | 54 (+ context-gated weak verbs) | 6/6 | 0/5 | dialect (Bhojpuri/Awadhi/Haryanvi), spelling variants (ड़/ड, nukta), indirect threats | Medium | NOT_REVIEWED |
| Hinglish (Hindi, Latin script) | 55 (+ context-gated) | 7/7 | 0/7 | unlimited spelling variation ("maarta/marta/maartha"), Urdu-origin words, SMS shorthand | Medium | NOT_REVIEWED |
| मराठी (mr) | 29 | 4/4 | 0/3 | regional forms, Latin-script Marathi not detected | Low–medium | NOT_REVIEWED |
| বাংলা (bn) | 26 | 4/4 | 0/3 | Sylheti/colloquial forms, Banglish not covered | Low–medium | NOT_REVIEWED |
| অসমীয়া (as) | 22 | 3/3 | 0/2 | smallest coverage; shares script with Bengali | Low | NOT_REVIEWED |
| తెలుగు (te) | 29 | 4/4 | 0/3 | agglutinative forms, Latin-script Telugu | Low–medium | NOT_REVIEWED |
| தமிழ் (ta) | 29 | 4/4 | 0/3 | spoken vs written Tamil, Tanglish | Low–medium | NOT_REVIEWED |
| ಕನ್ನಡ (kn) | 20 | 3/3 | 0/2 | inflection coverage thin | Low | NOT_REVIEWED |
| മലയാളം (ml) | 22 | 3/3 | 0/2 | inflection coverage thin, Manglish | Low | NOT_REVIEWED |
| ગુજરાતી (gu) | 23 | 3/3 | 0/2 | regional forms | Low | NOT_REVIEWED |
| ਪੰਜਾਬੀ (pa) | 22 | 3/3 | 0/2 | Shahmukhi script not supported (by design); nukta variants | Low | NOT_REVIEWED |
| ଓଡ଼ିଆ (or) | 18 | 3/3 | 0/2 | smallest coverage | Low | NOT_REVIEWED |

## Design rules
- All lexicons run on every text regardless of detected language (mixed-language messages can't slip past by using the "wrong" one).
- Word-start boundaries prevent substring hits ("हमारा" ≠ "मारा", "peeth" ≠ "peet", "marathi", "Kumar").
- Ambiguous verbs ("maara", "मारा" — also used for mosquitoes or sport) count only with a person as object ("mujhe", "बच्चों को") or directly after a third-person subject ("woh maarta hai", "usne maara"). Vocabulary was not deleted to avoid false positives.
- A match triggers a **neutral** safety flow ("This situation may involve a safety concern"), never an accusation; the guidance explicitly says it is not a judgement about anyone.
- Only adds holds; never clears one; fails closed on malformed input.

## Known false-negative classes (all languages)
Indirect or implied threats ("you'll regret it"), euphemism, code words, threats in images/voice notes, misspellings beyond listed variants, Latin-script forms of languages other than Hindi, and any phrasing the author didn't think of.

## Required before calling any language production-reviewed
Native speakers (ideally with domestic-violence support experience) review terms and templates; build a de-identified evaluation set per language with false-positive and false-negative rates; review safety guidance wording with a local support organisation.

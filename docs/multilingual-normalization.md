# Multilingual semantic normalization

Supports English, Hinglish, Hindi, Marathi (Devanagari and Romanized). Additional Indian languages: add lexicon entries
and language tags (`RelLang` already lists 12 languages; non-covered languages are marked `limited` with lower confidence).

## Principle
Normalise **meaning**, not words, into structured items — always `inferred` until the writer confirms.

```
"mala thoda space pahije pan breakup nahi karaycha"
  detected: mr-latn (latin script)
  → relationship_direction.wants_space = true            (about: self, inferred)
  → relationship_direction.breakup_intent_explicit = false  (a recorded denial)
  NOT: "does not want breakup"   NOT: "loves partner"   NOT: any attachment/intent label
```

## Output (`normalizeText`)
`originalText` (caller-local, never persist/log), `detectedLanguage`, `script`, `semantics[]` (+ pattern id, never text),
`safetyCategories/Signals`, `confidence` (≤ 0.5; 0.25 for limited languages), `needsConfirmation`.

## Rules
1. Pronoun matters: "I need space" is about the writer; "She wants space" is about the partner → can only become a
   **partner report**, never her own statement.
2. A denial is stored as a denial (`false`), never rewritten into a positive claim.
3. Forbidden attributes (love, cheating, narcissism, attachment, manipulation, loss of interest, breakup intention,
   diagnosis…) are rejected at extraction and at observation creation.
4. `confirmDraft` is the only path to explicit evidence and creates a *new* observation (history kept).
5. AI-assisted extraction (`buildExtractionPrompt` / `parseAiExtraction`): closed construct list, snippet ≤ 600 chars,
   unknown constructs and forbidden attributes rejected; items stay `inferred`.

## Privacy
Send only the minimal snippet; do not store provider-side where configurable; never put text in analytics, logs or error
reports. The engine and DB hold structured values only.

## Limits
Lexicon coverage is deliberately small (space, breakup denial, rhythm preference, reply latency, feeling understood,
in-person attentiveness). It misses many phrasings and was not native-speaker reviewed. Expect false negatives; the
design fails toward "no conclusion".

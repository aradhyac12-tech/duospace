# Multilingual support — English + Indian languages (2026-09-25)

Owner decision: DuoSpace supports **English and Indian languages** — हिन्दी, मराठी, অসমীয়া, বাংলা, తెలుగు, தமிழ், ಕನ್ನಡ, മലയാളം, ગુજરાતી, ਪੰਜਾਬੀ, ଓଡ଼ିଆ. Urdu / Roman-Urdu is **not** a target. The previous app language list (es, fr, de, pt, ja, ar) was replaced; a saved choice of one of those falls back to device language or English.

## What was built
| Piece | File | What it does |
|---|---|---|
| App language list | `src/lib/i18n.ts` | 12 languages with native names and taglines (Settings → Language) |
| Detection | `src/lib/relationship/i18n/lang.ts` | Script-based (Unicode blocks); Hindi vs Marathi and Bengali vs Assamese by marker words / Assamese letters ৰ ৱ; Hindi typed in Latin script ("Hinglish") by marker words |
| Safety lexicon | same file | Violence/threats, stalking/monitoring, isolation, financial coercion, sexual coercion, blackmail, self-harm threats used as control, threats to children, immediate danger — in all 11 Indian languages + Hinglish. Checked on every answer in **every** language regardless of the detected one. Word-start boundary so e.g. "हमारा" doesn't match "मारा". Only ever adds a safety hold. |
| Localized templates | `src/lib/relationship/i18n/strings.ts` | 24 fixed strings per language: safety guidance (incl. India emergency number 112), limited-mode notice, unknowns, clarifying questions, message connectors |
| Limited mode | `repair/index.ts`, `responsiveness/index.ts` | When the user's text isn't English, **nothing is interpreted**: words shown verbatim, no fact/interpretation splitting, no pattern-based "what may matter"; replies built from the user's own words inside fixed localized templates; clarification first |
| UI | `RepairPanel.tsx`, `ResponseSupportPanel.tsx` | Passes the app language; safety guidance follows the language the user is typing in |

## Why "limited mode" instead of full analysis
The Phase 3A–3C engines are English pattern rules. Applying them to Hindi or Tamil would silently do nothing — or worse, mis-read. Pretending to analyse would violate the grounding principle. So non-English text gets structure and safety, not interpretation. Real multilingual understanding needs either a validated local model or per-language rule sets reviewed by native speakers.

## Tests (`src/test/i18n/multilingualRelationship.test.ts`, 49 tests, PASS)
Language list; detection for all 12 + Hinglish; a danger phrase per language → SAFETY_HOLD (no message, not shareable); benign sentences (incl. "हमारा", "peeth") not flagged; safety guidance in every language with 112; limited mode for repair (Hindi, Tamil incl. optional apology and preserved boundary) and response support (Telugu, Bengali auto-detected); every template present in every language with `{x}` kept.

## Honest limits
- **All non-English text was written without native-speaker review.** Taglines, templates and safety guidance must be reviewed per language before public release. Gendered verb forms are shown as "लेता/लेती" style where needed.
- **The safety lexicon is small** (roughly 20–40 phrases per language) and will miss many phrasings, dialects and spellings; it may also over-trigger. Real-world accuracy: NOT MEASURED.
- Mixed-language messages use the dominant script. Hinglish detection is heuristic.
- Values/Expectations questionnaire (Phase 3A) and the rest of the app's UI are still English; only the relationship-AI outputs and safety text are localized.
- No local model → no real understanding of meaning in any Indian language.

## Next steps
Native-speaker review per language (templates + lexicon); expand lexicons with reviewers and support organisations; translate the Values questionnaire and panel UI; evaluate a multilingual local model before enabling any interpretation in these languages.

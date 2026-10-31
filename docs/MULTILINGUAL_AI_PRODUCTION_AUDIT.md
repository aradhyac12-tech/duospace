# Multilingual AI — Production Audit (2026-09-25)

**Verdict: NOT production-ready.** Architecture and privacy PASS; safety coverage and translations are NOT native-reviewed; the app UI is almost entirely English.

| Area | Status | Evidence / notes |
|---|---|---|
| Supported languages | PASS | en, hi, mr, as, bn, te, ta, kn, ml, gu, pa, or; Urdu excluded (test) |
| Detection architecture | PASS | local, deterministic, Unicode-script + marker words; Hinglish heuristic; Hindi/Marathi, Bengali/Assamese, Punjabi tests |
| Selected-language propagation | PASS | app language → service `language` option; typed-text language overrides for templates |
| Safety integration | PASS (after fix) | gate now in Conflict Repair, **Help me respond (newly added)**, and memory/agreement sharing (newly added) — one shared `checkSafety`, no duplicate systems |
| Safety coverage | PARTIAL | see `docs/MULTILINGUAL_SAFETY_REVIEW.md`; 18–55 phrases per language; NOT_REVIEWED |
| False positives | PARTIAL | 0 on 40 benign probes; fixed an existing English FP ("I need some space **right now**" was treated as immediate danger) |
| False negatives | PARTIAL | 2 found (photo-blackmail phrasings) and fixed; real-world rate NOT MEASURED |
| Limited mode | PASS | non-English text shown verbatim; no semantic inference, no model, no translation; static test: no network/storage/logging in `i18n/` |
| Cloud translation | PASS | none exists or is called |
| Emergency guidance | PASS (changed) | 112 shown only when device region is India (locale `-IN` or `Asia/Kolkata`); otherwise neutral "your local emergency number". App language is never used to guess the country. |
| Localization of UI | FAIL (documented) | ~1,470 English strings in `src/**/*.tsx` (core UI ~1,087, settings ~201, relationship panels ~151, UI primitives ~31; `docs/eval/ui_string_inventory.json`). Choosing a language in Settings changes only the splash tagline and relationship-AI outputs/safety text. No translation framework exists, so translating it is not low-risk and was not done. |
| Native review | NOT VERIFIED | none performed |
| Privacy of detection | PASS | runs locally; no text sent, logged or stored; only the chosen app language is stored (existing behaviour) |
| Performance | PASS (sandbox) | 89 short messages, all 12 lexicons + detection: p50 0.89 ms / p95 1.16 ms per batch; 6.3k chars: p95 1.05 ms (Node.js, NOT a phone). Chat send, mood and calls don't call it (grep). |
| Device testing | NOT VERIFIED | |

## Changes made in this audit
Locale-aware emergency number; context-gated ambiguous Hindi/Hinglish verbs plus missing phrases ("usse darr", "phone ko check", "dhamkaya", photo blackmail variants); "right now" false positive removed; safety gate added to Help-me-respond and to memory/agreement sharing.

## Remaining blockers
Native-speaker review of lexicons and templates; a real evaluation set; a translation framework for the app UI; device testing; any real multilingual understanding requires a validated local model (still BLOCKED).

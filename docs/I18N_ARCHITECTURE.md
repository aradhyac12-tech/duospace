# I18N Architecture (Phase 3E)

One system, in `src/lib/i18n.ts`. No second framework.

## Pieces
| Piece | Where | Purpose |
|---|---|---|
| Language list, selection, persistence, subscription | `SPLASH_LANGUAGES`, `getLanguageCode`, `setLanguageCode`, `subscribeLanguage` | existing (Settings → Language) |
| UI catalogs | `registerCatalog(lang, entries)` | flat `key → string` per language; English is the source of truth |
| Lookup | `tr(key, vars?, lang?)` | interpolation `{name}`; plurals via `Intl.PluralRules` (`key.one` / `key.other`) |
| Fallback | `fallbackChain(lang)` | selected (`hi-IN`) → base (`hi`) → `en` → the key itself. Never blank, never throws |
| Direction | `isRtl()` | always false: every supported language is LTR (Urdu excluded; no Indic script is RTL) |
| Safety-critical text | `src/lib/relationship/i18n/strings.ts` `t()` | separate on purpose: fixed reviewed English fallback per key; the generic chain is NOT used for safety |
| Emergency region | `detectEmergencyRegion()` | device locale `-IN` or India time zone → "IN"; otherwise neutral. Never from app language |

## Key naming
`<priority>.<area>.<name>` e.g. `p0.memory.deleteAllConfirm`, `p1.chat.send`. Accessibility labels use the same catalog (`p1.chat.sendButton.aria`). Error codes map to keys (`p0.error.<CODE>`), not raw messages.

## Formatting
Dates/numbers via `Intl.DateTimeFormat` / `Intl.NumberFormat` with the selected language (Indian digit grouping comes from `en-IN`/`hi-IN` etc.). Not yet adopted across the app.

## Priorities (`docs/eval/ui_string_inventory.json`)
- **P0** safety, permissions, authentication, errors, privacy, consent, deletion, sharing — first. Safety done (relationship strings). Started: 8 P0 keys in `MemoryPanel` (consent/deletion/sharing/errors).
- **P1** navigation, Chat, Calls, Profile, Settings, relationship actions.
- **P2** secondary screens. **P3** rare/debug.

## Translation workflow
1. Move a string to a key with English source. 2. Export keys to the review pack. 3. Native reviewer supplies text + structured review. 4. `registerCatalog(lang, …)`. 5. Tests assert every P0 key has a non-empty English source and that missing languages fall back to English.
**No non-English P0 text was added in Phase 3E** — deliberately, until native review, so no unreviewed consent/deletion/safety translation can mislead a user.

## Status
Architecture PASS (6 tests). Coverage: 8 P0 keys adopted; ~1,460 strings remain.

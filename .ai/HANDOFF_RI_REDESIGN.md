# Handoff — Relationship Intelligence redesign (base v3.22.9)

## Finding
Chat-first RI already exists: contextual/extract.ts (single fact engine, provenance, content-hash cache) + present.ts (Understand / reply intents / Today selection), QuickReplySheet, UnderstandSheet, TodayInsight (inside Reflection "insights" tab). Do NOT rebuild; refine.

## Done (UNVERIFIED — sandbox had no network/node_modules)
- UnderstandSheet: removed AI_STANDARD quota (deterministic).
- QuickReplySheet: quota only when `r.usedModel`.
- MessageContextMenu: 3 groups with dividers; labels via tr().
- i18n keys: p1.menu.*, p1.rel.*, p1.intent.* (English only); Reflection hint/More tools via tr(); reply-intent labels via tr().
- Today empty copy: "Nothing to flag today." (test updated).
- Tests: test/contextual/understandNoQuota.test.ts (source-level).

## Also done since (UNVERIFIED)
- Reflection.tsx 785→~635 lines: InsightsTab + friendlyError/EvidenceLine/SharePreviewDialog moved to components/relationship/InsightsTab.tsx and reflectionShared.tsx; unused imports pruned by script (check lint for any missed/over-pruned import).
- test/contextual/communicationFacts.test.ts (provenance spans, "Whatever.", emoji, adversarial, cache-by-hash, no network). Written without running; expectations derived from reading extract.ts/present.ts, so adjust if a pattern differs.

## Also done (3rd pass, UNVERIFIED)
- ReflectTab extracted (components/relationship/ReflectTab.tsx); Reflection.tsx now ~563 lines. Values/Expectations tabs still inline (~150 lines each, `any` props).
- QuickReplySheet footer behind "Why?" toggle. Chip row still has 4 chips (incl. "Ask first", which duplicates the intent chip; contextualUi.test expects it — remove both together to reach Another/Shorter/Casual).
- hi/mr/Hinglish translations NOT added: src/lib/i18n.ts policy requires native review; new keys listed in docs/NATIVE_LANGUAGE_REVIEW_PACK.md.

## 4th pass (UNVERIFIED)
- Reflection.tsx now ~278 lines: ValuesTab, ExpectationsTab, ReflectTab, InsightsTab + reflectionShared.tsx all in components/relationship/ (imports generated/pruned by script — typecheck first; check ValuesTab/ExpectationsTab each define their own CATEGORY_ORDER).
- Reply chips trimmed to Another/Shorter/More casual ("Ask first" is the intent chip only); contextualUi.test updated.
- privacyRedTeam.test AI_FILES widened to components/relationship/* + QuickReply/Understand sheets (moved code must stay scanned). If it newly fails on existing component files, fix the code, not the scan.

## 5th pass (UNVERIFIED)
- Hardcoded English in Values/Expectations/Reflect/Insights tabs + reflectionShared (toasts, dialogs, placeholders, empty states, friendlyError) moved to `tr("p1.rel.*")` keys in src/lib/i18n.ts (English catalog). Done by regex script — typecheck, and eyeball ValuesTab/ExpectationsTab JSX.
- hi/mr/Hinglish: intentionally NOT added; waits for native review (docs/NATIVE_LANGUAGE_REVIEW_PACK.md lists all pending keys). Add via registerCatalog("hi"|"mr", …) after review; Hinglish needs its own catalog code if the app has one (check SPLASH_LANGUAGES).
- Not localized (lib labels): CATEGORY_LABEL/TYPE_LABEL/IMPORTANCE_LABEL/REFLECTION_PROMPTS/VALUE_QUESTIONS from src/lib/relationship.

## Verification attempt (6th pass)
- `npm ci` blocked (registry 403, no network) → vitest/eslint/build NOT runnable here. Used global tsc 6.0.3 with a temp config (types:[], skipLibCheck, noUnusedLocals) over all changed files: found and FIXED real bugs from the Reflection split — EXPECTATION_TYPES/IMPORTANCE_LEVELS had been moved into ValuesTab (now in ExpectationsTab), unused `Check` imports, unused `ToastFn`. Changed files now have 0 undefined-name / unused errors; only missing-third-party-module noise remains (expected without node_modules). All changed files also pass a syntax transpile.
- Still must run on a networked machine: npm ci, full `tsc` typecheck, ESLint (report baseline/new/total warnings), vitest (incl. new tests), verify:lock, build, Android gate, RLS/secret scan.

## Next steps
1. `npm ci && npm run typecheck && npx eslint . && npx vitest run && npm run verify:lock && npm run build` — fix anything from the above edits first (esp. i18n import in present.ts, menu tests).
2. Add hi/mr/Hinglish translations for p1.* keys.
3. (done) Reflection split; keep Memory/Values/Expectations/Reflect/Repair reachable.
4. Sheet polish: QuickReplySheet/UnderstandSheet visual hierarchy, long-text wrapping, large font, keyboard.
5. Tests: extraction (Hinglish/Marathi/Hindi, sarcasm, "whatever", emoji-only), stale-cache/hash mismatch, never-auto-send, no network.
6. Real-device checks: long-press discoverability, TalkBack, dark mode, multilingual wrapping.

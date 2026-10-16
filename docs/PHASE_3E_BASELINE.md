# Phase 3E Baseline (2026-09-25, before any Phase 3E change)

| Item | Value |
|---|---|
| Repository version | 3.16.1 |
| Commit | NOT AVAILABLE — the delivered zip contains no `.git` directory |
| Tests | 94 files, 1136 passed, 2 skipped, 0 failed (`npx vitest run`, exit 0) |
| Known failures | none |
| AI execution modes | LOCAL (model BLOCKED), RULE_BASED (active), E2E_CLOUD (blocked by design), UNAVAILABLE |
| Local model | manifest `tokenizerVersion: "unpinned"`, every file `sha256: ""`, `bytes: 0` → artifact not present; integrity check cannot pass |
| Supported languages | en, hi, mr, as, bn, te, ta, kn, ml, gu, pa, or (Urdu excluded) |
| Localization | ~0% of ~1,470 app UI strings (only splash taglines + relationship-AI templates/safety text localized) |
| Phase 3D | KEEP + FIX, D1–D4 fixed (docs/PHASE_3D_FORENSIC_AUDIT.md) |
| Native builds | Android SDK / Xcode not present in sandbox → BLOCKED |
| Devices / live Supabase / native reviewers | not available → BLOCKED |

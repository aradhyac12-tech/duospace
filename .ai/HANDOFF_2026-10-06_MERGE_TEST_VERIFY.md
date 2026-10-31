# Handoff 2026-10-06 — merge of duospace-v3_22_9 + test-handoff-59af4034, test verification

## Merge
- test-handoff-59af4034.zip (prefix `project/`) is an OLDER, pre-haptics snapshot of duospace-v3_22_9-premium-haptics-layered.zip. It has no files the newer zip lacks; 186 test files in each, all byte-identical.
- Merged result = the v3_22_9 haptics-layered tree (superset). Differences from the older zip: native-plugins/haptics, src/lib/hapticEngine.ts, globalHaptics.ts, HapticOnMount, HapticLab, useHapticOnMount, haptics.ts rewrite, alias wiring (vite/vitest/tsconfig/package.json), main.tsx initGlobalHaptics, capacitor gradle/plugins.json, several chat/ui components.

## Test run (`npx vitest run`, npm ci --ignore-scripts)
- 178 files, 2318 tests: 2297 passed, 19 failed, 2 skipped (realModel.eval, intentionally).
- The SAME 19 failures reproduce on the older pre-haptics snapshot → none introduced by haptics/merge. surpriseHapticDNA.test.ts passes.
- Pre-existing failures:
  - selfHostedCallEngineAdapter.test.ts (13): livekit-client mock lacks `createLocalAudioTrack`.
  - mediaService.test.ts: vi.mock factory references top-level variable (hoisting error).
  - appUpdate.test.ts: spy called with extra 3rd arg after ('android', 32101).
  - mediaValidation.test.ts: arbitrary bytes labelled image/jpeg is accepted.
  - phase3kRelationshipUiI18n.test.ts: hi translation present where test expects English fallback.
  - multilingualRelationship.test.ts: language list has more entries than the test pins.
  - surpriseDocument.test.ts: generated frame doc contains backdrop-filter.
  - privacyRedTeam.test.ts: src/lib/ai/cloud/gatewayClient.ts makes Supabase call in analysis path.
- Not run: tsc, eslint, vite build, Android/iOS, device tests.

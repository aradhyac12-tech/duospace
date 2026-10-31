# Call preview + smoothness pass (v3.22.43) — handoff

## Changed files
- src/components/calls/CallStage.tsx — self-preview tile placement/bounds/rotation, ringing full-screen self preview, flip-camera gating + guard, header/badge cleanup.
- src/components/calls/MinimizedCallBubble.tsx — partner-video condition, reattach on mount, rotation re-snap, >1h timer.
- src/components/IncomingCallOverlay.tsx — Enter-key fix, initial fallback. No call logic touched.
- src/test/callUiWiring.test.ts (flip button now wired via handleFlipCamera), src/test/callPreviewFixes.test.ts (new, static checks).
- package.json (3.22.43), android/app/build.gradle (versionCode 32243).

## Verified (actually run, with real node_modules this time)
- tsc -p tsconfig.app.json: no new errors vs the original zip. Call files: 0 errors.
- eslint on src/components/calls + IncomingCallOverlay: clean.
- vitest (full): 2746 passed, 3 failed, 2 skipped. All 3 failures reproduce on the untouched v3_22_42 zip: musicLibraryAndPlayNext "reflects Play next immediately in the window", ai-eval/fixtures "UNDERSTAND accepts: quote-from-recent-message", appUpdate version stamp (fixed here by stamping build.gradle).
- npm run verify:lock: pass. npm run build: pass.

## NOT verified
Any runtime/visual behaviour: rendering, rotation, notch/safe areas, two-device calls, Android/iOS WebView camera enumeration, ringing preview with a real camera. Follow docs/CALL_UI_TWO_DEVICE_CHECKLIST.md.

## Pre-existing, left alone
- ~35 tsc errors outside call code (admin tabs, chat/QuickReplySheet, relationship AI cloud*/AdaptiveQuestionCard, Groic.tsx, Auth.tsx, usePushNotifications, localLibrary, supabase/_shared/ai/gateway.ts, a few tests).
- 2 failing tests above (music play-next window; AI-eval fixture "category" typing).
- package-lock.json still says 3.22.9 (cosmetic per check:lock; regenerate with `npm install` in a normal environment).
- Incoming screen intentionally has NO self-camera preview: DO_NOT_CHANGE forbids auto-activating the camera before an explicit user action.
- Dead state in CallStage (showMoreSheet, PiP, screen-share) is still declared but unrendered.

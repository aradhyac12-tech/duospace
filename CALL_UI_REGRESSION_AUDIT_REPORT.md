# Call UI redesign — regression audit (baseline: duospace-v3_22_39, candidate: v3_22_40 + fixes)

## Method
Full tree diff (orig vs candidate), AST comparison of every event handler / aria-label / aria-pressed / ref / drag prop / id / autoFocus in the 3 changed components, review of every non-className diff line, token + theme-engine inspection.

## Scope of change (vs original)
Modified: src/components/calls/CallStage.tsx, src/components/IncomingCallOverlay.tsx, src/components/calls/MinimizedCallBubble.tsx, src/index.css (+30), tailwind.config.ts (+9), .ai/CHANGELOG.md.
Added: src/lib/callChromeTone.ts, src/test/callChromeTone.test.ts, src/test/callRedesignTokens.test.ts, src/test/callUiWiring.test.ts, HANDOFF_CALL_UI_REDESIGN.md, this report.
Untouched: CallContext, call engine, signaling, state machine, permissions, themeEngine, customThemes, Calls.tsx, Chat.tsx, CallOverlay.tsx, backend, schemas, auth.

## Confirmed regressions introduced by the first redesign (all fixed here)
1. Chrome forced to white on every video call. When the surface behind it is the themed stage (video "connecting", partner camera off) in a light theme this was white-on-ivory. Fix: tone now follows the real surface (lib/callChromeTone.ts); ringing on a video call scopes the foreground token to white.
2. Black top/bottom scrims were drawn on every non-voice call, including over the light stage -> now only when the surface is video.
3. Control tokens (--call-ctrl*) were fixed light/dark values, so a custom theme overriding --call-stage(-foreground) could make ghost/active control states invisible. Now derived from those tokens.
4. 4 controls x 64px min-width overflowed the bar at 320px width. Now 56px.
5. Two static backdrop-blurs remained ("Sharing" badge) despite the stated goal -> removed.
6. Incoming avatar (176px) could crowd the buttons in short landscape viewports -> 96px when max-height <= 480px.

## Pre-existing in the ORIGINAL (not regressions; left as-is, counts identical in both trees)
- showMoreSheet/setShowMoreSheet, showRoutePicker, togglePip/pipSupported/isPip, screenShareSupported/toggleScreenShare, cameras, RouteIcon are declared but never rendered. The original's own comment says the screen-share and More (audio output / camera / PiP) buttons were removed from the bar.
- toggleSpeaker can call setShowRoutePicker(true) when several non-speaker routes exist: nothing renders, so that tap does nothing visible. NOT fixed here (needs a product decision: restore a picker or fall back to a route).
- Voice call shows partner name in both header and centre; header swaps "End-to-end encrypted" for the timer.
- formatDuration grows when passing 1 hour (width change).
- Incoming screen has no quick-message action and no remote preview (no stream exists pre-accept).
- Resolution badge derives from existing networkQuality / browser connection state (not new).

## Observations, not changed
- Wine accent button on the dark stage has ~1.4:1 boundary contrast vs the stage (icon/label contrast is fine, ~8:1). Consider a lighter dark-mode wine.
- Tailwind arbitrary `[@media(max-height:480px)]:` relies on Tailwind >= 3.x arbitrary variants (build not run).

## Wiring trace (UI event -> handler), identical in both trees
Minimize -> setIsCallMinimized(true) | Mute -> toggleAudio() | Speaker -> toggleSpeaker | Camera -> toggleVideo() | End -> handleEnd (cancelAcceptingCall / cancelStartingCall / endCall) | Flip -> cycleCamera() | Lip reading -> setShowLipReading | Decline -> handleDecline | Accept -> handleAccept | Enter/Escape listener unchanged | Bubble expand -> setIsCallMinimized(false) | Bubble end -> handleEnd -> hangUpCall. No effect, timer, listener or cleanup was added, removed or edited (3 framer-motion infinite animations were replaced by CSS animation, so fewer JS animation loops).

## Commands executed and actual results
- npm ci --ignore-scripts: FAILED — npm registry unreachable (network disabled); aborted mid-extract. Partial node_modules removed. Therefore NOT RUN: npm run lint, tsc/type-check, vitest, npm run build, verify:lock.
- TypeScript 6.0.3 (global) transpile syntax parse of all edited/new .ts/.tsx: OK. This is syntax only, not type-checking.
- New tests run through a minimal hand-written vitest shim (not real vitest): callChromeTone 5/5, callRedesignTokens 8/8, callUiWiring 10/10. They have NOT been run under the project's vitest/jsdom.
- AST handler-comparison script orig vs candidate: 0 differences in all three components.

## Unverified
Everything at runtime: rendering, Tailwind class generation, Android/iOS/WebView behaviour, notch/safe areas, rotation, real two-device calls, reduced-motion on a device, contrast on real themes.

## Release recommendation
NOT release-ready. Required before release: `npm ci && npm run verify:lock && npm run lint && npx tsc -p tsconfig.app.json --noEmit && npm test && npm run build`, then the two-device checklist (docs/CALL_UI_TWO_DEVICE_CHECKLIST.md) on Android + iOS, light and dark, plus one custom theme.

## Follow-up: speaker interaction fixed (v3_22_42)
Cause (pre-existing): toggleSpeaker opened `showRoutePicker`, but nothing rendered it; and with several non-speaker routes it silently picked the first one instead of the documented "open the picker".
Fix (CallStage.tsx + new lib/speakerToggle.ts): pure `decideSpeakerAction` -> set route / open picker / none. Picker is now rendered (dialog "Audio output", route list with icon + check + aria-current, Cancel, backdrop tap and Escape close, selecting a route calls the existing audioRoute.setRoute). Empty route list -> refresh + toast instead of a dead tap. Web (setSinkId) path unchanged. Removed a `.catch` on setRoute because it never rejects.
Tests: src/test/speakerToggle.test.ts (5/5 via stand-in runner, NOT real vitest) + a static render-site check in callUiWiring.test.ts. Not run: real vitest, lint, tsc, build, device (Bluetooth/wired routing is unverified).

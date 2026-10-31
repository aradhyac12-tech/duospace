# Call UI redesign (presentation layer only) — handoff

## Changed files
- src/components/IncomingCallOverlay.tsx — full-screen + slim-banner JSX only. handleAccept/handleDecline, refs, timers, listeners, keyboard (Enter/Escape), autoFocus on Decline: untouched.
- src/components/calls/CallStage.tsx — render only (voice/ringing/camera-off layouts, header, control bar). Added 3 derived consts (onVideo, fg, fgMuted). No hook/handler/effect changed.
- src/components/calls/MinimizedCallBubble.tsx — styling only; handlers unchanged.
- src/index.css — additive tokens (--call-accent*, --call-ctrl*, --call-shadow), .call-ring keyframes (reduced-motion safe), .call-num.
- tailwind.config.ts — call-accent / call-ctrl colors.

## Not changed
CallContext, call engine, signaling, state machine, permissions, themeEngine (--call-stage / --call-stage-foreground stay the theme hook).

## Verified vs not
- Verified: TypeScript syntax parse of the 3 TSX files (transpile only).
- NOT run: tsc type-check, eslint, vitest, vite build (no node_modules; network disabled). NOT device-tested (Android/iOS/web).

## Pre-existing items found, left as-is
- CallStage: toggleSpeaker may call setShowRoutePicker(true), but no route-picker UI is rendered (More sheet/PiP/screen-share buttons were removed earlier; state/hooks remain). Dead path.
- Incoming screen has no quick-message action and no remote video preview (no stream exists before accept).
- Quality badge (resolution label) is derived from existing networkQuality state; unchanged.

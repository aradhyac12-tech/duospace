# Handoff — 2026-10-06 — IncomingCallOverlay TDZ crash (DS-UNKNOWN-001)
Fixed: `ringingCallId` used in the watchdog effect deps before its `const` declaration -> render-time ReferenceError caught by ErrorBoundary. Declaration moved up (IncomingCallOverlay.tsx).
Verified: tsc (no TS2448/2454/2449), callBusyOutcome vitest. Not verified: full test suite, vite build, device.
Next: rebuild APK/OTA bundle and confirm the error stops recurring; sourcemaps for index-CqZoPIFr.js were not available, so the component was identified via tsc, not the minified offsets.

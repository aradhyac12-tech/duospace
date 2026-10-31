# Handoff — theme visual system pass (2026-10-05, based on v3.22.10)

Scope: visual only. No change to auth, Supabase, schema/RLS, chat, calls, AI, music, routing, couple theme sync, or any theme capability.

Files: themeEngine.ts, customThemes.ts, themeBoot.ts (new), ThemeContext.tsx (2 exports), main.tsx, index.html, index.css, AppLayout.tsx, AppBootScreen/SplashScreen/LocationAccessGate.tsx, ThemePicker.tsx, ThemePreview.tsx (new), ThemeStudio.tsx, CallHistoryRow/NotificationsSettings/Profile/MessageComposer (semantic tokens), test/themeVisualSystem.test.ts (new).

Design rules to keep: surfaces are neutral (THEME_TINT_STRENGTH), colour lives in primary/accent/--ambient-glow, semantic colours (destructive/success/warning/info) never follow the theme, glass is for dock/composer/player/hub/sheets only. Do not add a second derivation path; extend deriveTokens.

Must be checked on a device: Midnight/Wine/Noir dark + AMOLED, a light preset, high contrast, reduced transparency, a colourful preset, custom HSL, an imported theme, a couple-synced theme; cold start with a non-default saved theme (no colour flash); Theme Studio sections on a small phone; whether the ambient wash is visible/too strong on the real home surfaces.

Open decisions: native splash/Capacitor backgroundColor (#121316) vs themed web boot; micro-grain deliberately not implemented; remaining palette-class audit in chat/admin/map screens (left: semantic or media).

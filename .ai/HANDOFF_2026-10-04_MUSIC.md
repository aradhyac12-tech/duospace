# Handoff — 2026-10-04 — v3.22.8 Groic suggestions / auto-next

See the v3.22.8 entry in CHANGELOG.md for root causes. Files: src/pages/Groic.tsx, src/lib/music/{railDedupe,queueQuality,autoNext,trendingMix,playHistory}.ts, src/contexts/GroicContext.tsx, src/test/musicRailsAndFallback.test.ts.

## Done
- Rails no longer empty after tapping a song; language chips no longer blank the home; non-Latin titles no longer collapse; auto-next fallback ladder.

## NOT verified
- Device/browser run. Live provider calls. Please test: tap a song in each rail, toggle languages quickly, let a short queue run out.

## First steps next
1. Build the APK (version = package.json 3.22.8) and run the three checks above on a phone.
2. Pre-existing: 12 failing tests in 3 files (unchanged), TS2367 at GroicContext.tsx:1007.

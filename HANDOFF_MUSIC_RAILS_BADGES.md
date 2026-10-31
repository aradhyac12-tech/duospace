# Handoff: music source badges, 15+ song rails, chat alignment

## Source badges (src/components/music/MusicUI.tsx)
New `ProviderBadge`: solid brand-colour chip with 2-letter code on the artwork - SC (SoundCloud orange),
YT (YouTube red), AU (Audius purple). Drawn on CoverCard (home rails), TrackRow, TopResult and the track
actions sheet. Audius dot colour changed to purple so dot + badge agree. (Assumed "ad" = Audius.)

## Rails now 15+ (Hindi, English, ...)
Causes: (1) trendingMix quotas capped SoundCloud/YouTube at 6 each (40%), so a thin Audius tier left ~6-12;
(2) Groic sliced to 12; (3) cross-rail dedupe could cut a rail to 4.
Fix: getTrendingRail default 24 + BACKFILL from unused tracks of all tiers; Groic fetches/shows up to 24
(TREND_RAIL_SIZE) and dedupeRails got a per-rail `minKeep` (15 for language rails). Test added in
src/test/musicRailsAndFallback.test.ts. If a language still has <15, the providers truly returned fewer
unique songs (check edge functions music-trending / soundcloud-search).

## Chat alignment (on top of previous pass)
- Partner bubbles paid 30px of width for the avatar column + invisible reply button; mine did not, so the two
  sides had different max widths. Reply hover buttons are now absolutely positioned (no layout space) and
  the partner row cap is calc(80% + 30px), so both sides get the same bubble width.
- Reply preview and edit banner were px-4 vs px-3 everywhere else -> now px-3 (flush with composer/bubbles).

## Not verified
No node_modules/network: not built, vitest/tsc not run (dedupe logic checked in Node only). Check on device.

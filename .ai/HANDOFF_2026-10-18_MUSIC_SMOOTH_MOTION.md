# Handoff — 2026-10-18 — Music motion pass (pull-down, minimise/maximise, close, play/pause, next/prev)

Base: duospace-v3_22_48-pull-refresh-back.zip. Version 3.22.33 -> 3.22.35 (package.json + android versionCode 32235 via patch-native-permissions.mjs; package-lock still stale, as before).

## What was rough (found by reading)
- Close (X) in the full player cleared `current`, and `if (!current) return null` unmounted the sheet on that frame: a hard cut, no exit.
- Play / Pause / spinner icons swapped instantly (React swap) in both players; equalizer bars/overlay popped in/out.
- Next/Prev gave no feedback beyond press-scale.
- touchcancel was handled as touchend, so a cancelled touch could COMMIT a minimise from half-way.
- Collapse spring was slightly under-damped (could overshoot the mini thumbnail); spring-back velocity was unclamped.
- Mini bar: spring exit (~400ms) overlapped the corner icon popping in; swipe-up to open had no finger feedback; no "landing" cue when the artwork reached the bar.

## Changes (code only)
- GroicFullPlayer.tsx: keeps the last track (lastCurrentRef) so Close slides down + fades (0.22s) instead of cutting; touchcancel -> glide back open (never commits); collapse spring critically damped (36.5) + mini-bar landing pulse; settle spring damping 36 -> 40; velocities clamped via springVelocity; equalizer fades; play/pause + prev/next use new components.
- NEW components/music/PlayPauseIcon.tsx (cross-fade + scale between play / pause / spinner, same grid cell, no layout shift), components/music/SkipButton.tsx (glyph nudges in travel direction on tap; driven from onClick because the sheet's onPointerDownCapture stopPropagation would block whileTap).
- GroicMiniPlayer.tsx: same icon/skip components; equalizer overlay fades; bar exit now a quick eased 0.2s (y 36, scale .96) so close / minimise-to-icon no longer overlap; swipe-up follows the finger (rubber-banded 24px), glides back on cancel, snaps to rest BEFORE expand() so the full player measures the true thumbnail; data-groic-mini-bar hook.
- NEW lib/music/miniLanding.ts (pulseMiniBar, WAAPI, skipped for reduced motion); lib/music/pullToMinimize.ts + springVelocity().
- Tests added (NOT RUN): pullToMinimize.test.ts (springVelocity cases), miniLanding.test.ts.

## Verified / NOT verified
RAN: TypeScript syntax-only transpile of all touched files = 0 diagnostics; version stamp script.
NOT RUN (no node_modules / network here): tsc, eslint, vitest, vite build, any device. Nothing was seen on screen. No frame-rate numbers.
Check on a device: pull from artwork (short pull springs back, flick commits, landing pulse), cancel by a system gesture mid-pull, tap chevron/back, open from mini bar (bar swipe-up, tap), X in full player (slide+fade) and X on mini bar, minimise-to-icon then restore, play/pause rapid taps, next/prev nudge, equalizer fade, reduced-motion setting.
Known limits: tab switches (Player/Lyrics/Queue/Details) still swap with an enter fade only (no exit); during Close the play icon briefly flips to "Play" because close() sets isPlaying=false first; Android WebView backdrop blur cost not re-profiled.

## Continue pass (3.22.35)
- Tab stage (Player / Lyrics / Queue / Details): AnimatePresence mode="wait" with a keyed neutral wrapper per tab (exit fade 0.1s, enter 0.18s). The wrapper is deliberately separate from the art morph element, whose opacity is a derived motion value that an exit prop would overwrite.
- Close: isPlaying / loading-buffering are frozen while the track is gone, so the play icon no longer flips and the equalizer no longer stops during the exit slide.
- Known-limits above are now closed in code; still NOT RUN: tsc, eslint, vitest, build, device. Syntax transpile of GroicFullPlayer = 0 diagnostics.
- Check on device: switch tabs rapidly (no blank stage / double stage), pull-down from a non-Player tab, queue/lyrics scroll still works inside the new wrapper (h-full chain), Close from each tab.

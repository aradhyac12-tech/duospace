# Handoff — 2026-10-09 — Music playback fixes + artwork→mini-bar morph

Files: src/contexts/GroicContext.tsx, src/components/GroicFullPlayer.tsx, src/components/GroicMiniPlayer.tsx.

## Done (code only)
- Rapid taps: toggle() read the isPlaying STATE (stale in one render) → two taps both paused. Now reads isPlayingRef, which play()/pause()/YT events update synchronously.
- Stuck spinner: `buffering` was only cleared by YouTube state 1; pausing/cueing while buffering left the button on a spinner AND the buttons ignored taps while "busy". Cleared on states 2/5 and in the 500ms reconcile poll; the `isBusy` tap-guard is removed from mini + full play/pause (spinner still shows).
- Pause while a native track is still resolving is honoured (load(resolved, wantPlay)) instead of force-starting.
- Offline copies no longer wait on the network lookup (sync isDownloaded check, remote only on a miss).
- Seek: position ticks are ignored for 700ms after a seek (thumb no longer jumps back); seek bar commits on pointercancel/touchend/touchcancel too (could freeze before).
- Pull-down: dragging the artwork (touch-action:none, so the browser can't hijack it) or tapping the chevron / system back animates the artwork onto the REAL mini-bar thumbnail ([data-groic-mini-thumb], measured) while the sheet/controls fade; opening from the mini bar runs it in reverse. Single `prog` motion value, no per-frame React renders.

## NOT verified
- No node_modules/network here: NO build, tsc, or tests were run — only a syntax transpile of the 3 files. Run `npm run verify:lock && npm run build` and the vitest suite (12 pre-existing failures noted in HANDOFF_2026-10-04_MUSIC.md).
- Never run on a device. Check: pull from the artwork lands on the mini thumb (also on /chat with the composer), quick flick, short pull springs back, mini bar minimized to corner icon (fallback target bottom-left), open from mini bar, chevron + back button, X still closes, pause during buffering, double-tap play/pause, seek-then-release.
- YouTube pause during its own loadVideoById can still resume after load (IFrame behaviour) — not changed.
- No version bump (tests hard-code 3.22.9).

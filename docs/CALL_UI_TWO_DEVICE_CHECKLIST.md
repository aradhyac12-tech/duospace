# Two-device call UI checklist (A = caller, B = callee). Run once in Light, once in Dark, once with a custom theme.
Mark each: PASS / FAIL / N-A. Record device + OS.

## Incoming
- [ ] Voice ring: B sees avatar, name, "Incoming voice call", Decline + Accept (labels visible); ringtone/vibration start once.
- [ ] Video ring: same with video icon/label; no preview expected.
- [ ] Accept (tap) -> in-call screen, ringing/vibration stop, no second ring after accept.
- [ ] Decline (tap) -> A sees declined; B screen closes; vibration stops.
- [ ] Enter = accept, Escape = decline (web/desktop).
- [ ] Caller cancels while B rings -> B screen closes, ringer stops.
- [ ] Native-owned ring: slim banner Decline/Answer work; tap body opens full screen.
## Outgoing
- [ ] A voice/video: name + avatar + "Calling…" -> "Ringing…"; ringback tone; End/cancel works at every stage.
- [ ] B never answers -> timeout outcome screen on A.
## Active voice
- [ ] Timer ticks without layout jump; Mute/Unmute label+icon+aria change and partner hears it; Speaker toggles route (native) or reports unsupported (web); End ends both sides.
- [ ] Speaker with Bluetooth + wired both present while on speaker: tapping Speaker opens the "Audio output" sheet; choosing a route switches audio, marks it with a check; Cancel/backdrop/Escape close it.
- [ ] Speaker with only earpiece+speaker: single tap toggles directly, no sheet.
## Active video
- [ ] Remote video dominant; header/controls light and readable in Light theme; self-preview draggable + snaps; flip camera works first tap; tap self-preview swaps; controls auto-hide after ~3.5s and a tap restores.
- [ ] Camera toggle on/off; partner camera off -> avatar fallback and header/controls readable in Light theme (stage colour, not white-on-ivory).
- [ ] Video ringing/calling text readable in Light theme (black behind).
- [ ] Rotate portrait<->landscape: no stretched faces, controls inside safe areas; 320px-wide device: 4 controls not overlapping.
## Minimize / navigation
- [ ] Minimize voice -> pill (avatar, name, timer, End); video -> thumbnail; drag/snap; tap expands; End ends the call once.
- [ ] Navigate Chat <-> Calls <-> Gallery/Settings during call: call persists, no duplicate timers/streams, remote video not blank after expand.
## Network
- [ ] Airplane mode on B 10s then back: Reconnecting… banner, then recovery; timer continues; no duplicate call.
- [ ] Kill app on B mid-call: A shows partner-left.
## Themes / a11y / motion
- [ ] Light, Dark, a custom theme with custom foreground, AMOLED: active states (Mute on, Speaker on) visibly distinct; wine Accept readable.
- [ ] System theme flips mid-call: call not interrupted.
- [ ] OS "reduce motion": rings static. Largest font size: buttons/labels not clipped. TalkBack/VoiceOver: every icon button announces its label.

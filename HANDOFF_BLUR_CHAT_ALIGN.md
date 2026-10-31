# Handoff: real blur cause + chat alignment

## Blur (root cause found)
ThemeContext "Privacy mode" blurred document.body (blur(20px)) on every window `blur` event. Tapping inside ANY
iframe of ours (surprise/Test preview, music) fires window blur on the parent, and focus stays in the frame so
`focus` never unblurs -> whole screen stays blurred. The earlier backdrop-filter kill-switch was unrelated.
Fix (src/contexts/ThemeContext.tsx): window blur is deferred one tick and ignored when focus is in a child
IFRAME, a surprise is open (html[data-surprise-open]) or document.hasFocus(); real background/hidden still
blurs; any pointerdown while visible unblurs as a safety net. Previous kill-switch left in (harmless).

## Chat alignment
- MessageComposer: Attach was 36px, Mic/Send/Hub 44px, textarea 40px, bottom-aligned with uneven pb-0.5 ->
  icons sat 2-4px off. Now all controls 44px, textarea min 44 with py-3, no stray pb-0.5.
- SurpriseMessage + important-message rows (MessageTimeline, both render paths) had their own px-3 inside the
  already px-3 scroll container -> inset 12px vs normal bubbles. Removed the extra padding.

## Not verified
No node_modules/network here: not built, no tests run, not viewed on device. Check composer on a multiline draft
and a surprise bubble edge vs a normal bubble.

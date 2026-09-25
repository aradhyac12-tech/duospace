# DuoSpace — Hub Positioning Fix + Optimistic Message Sending

**Context:** direct product feedback with a screenshot showing the in-chat
Hub panel rendering near the top-left corner instead of anchored
bottom-right, plus a request that sending text/photos/videos/files/voice
messages feel instant, with a WhatsApp-style progress indicator on slow
connections. Both fixed in place.

## 1. Hub opening in the wrong corner — root cause and fix

**Root cause:** `GridMenu.tsx` (the in-chat sparkle "Hub" panel) was
rendered inline inside `Chat.tsx`, which sits inside `AppLayout.tsx`'s
page-transition wrapper — a `motion.div` around `<Outlet />` that animates
`x`/`y`/`scale`/`filter` for route transitions. Framer Motion applies
those as literal inline CSS `transform`/`filter` styles, and by the CSS
spec, **any** ancestor with a `transform` or `filter` value other than
`none` becomes the containing block for `position: fixed` descendants —
instead of the actual viewport. GridMenu's panel used `fixed inset-0` +
`absolute right-3` + a `bottom: calc(...)` offset, all of which assumed
"relative to the screen." Once an ancestor several levels up silently
became its real positioning reference instead, that math landed the panel
somewhere else entirely — which is what the screenshot showed.

This is a general risk for any `fixed`-positioned element rendered from
inside routed page content in this app (not unique to GridMenu) — worth
keeping in mind for any future full-screen overlay built the same way.

**Fix:** `GridMenu.tsx` now renders through `createPortal(..., document.body)`
instead of directly in the component tree. A portaled node is a real,
separate top-level child of `<body>` — completely outside AppLayout's
transformed wrapper — so its `fixed`/`absolute` positioning is now
guaranteed relative to the actual viewport, regardless of what any
ancestor's CSS does. No other change to the panel: same glass styling,
same bottom-right anchor, same open/close animation, same content.

## 2. Optimistic sending: text, photos, videos, files, voice messages

**Before:** every send path (`handleSend` for text, `handleFileSelect` for
photos/videos/files, `sendVoiceMessage` for voice notes) cleared the
composer immediately but the message itself only appeared once Supabase's
INSERT completed and the realtime channel echoed it back — on a slow or
flaky connection, there could be a real, visible gap between tapping Send
and anything showing up. Media uploads used a single-shot
`supabase.storage.upload()` with no retry and no progress feedback at all.
If an insert or upload failed, the only signal was a toast — the message
itself never appeared, and there was no way to retry it.

**Now — the message appears the instant Send is tapped, before any
network round trip:**

- **Text:** an optimistic bubble with the actual typed text is added to
  `messages` immediately; encryption and the DB insert happen after, not
  before, the bubble is visible.
- **Photos/videos/files:** an optimistic bubble is added immediately using
  a local `URL.createObjectURL()` preview — the real photo/video is
  visible and (for voice) already playable while the upload is still in
  flight in the background, not a placeholder.
- **Voice notes:** same pattern — the recording is playable from the
  local blob the moment recording stops.

**Real progress, not a fake spinner, for media:** Chat's uploads now go
through `src/lib/resumableUpload.ts` — the same chunked, retrying,
resumable uploader Gallery already uses — instead of the old one-shot
`storage.upload()`. It reports genuine byte-level progress via
`onProgress`, which drives a small circular ring overlaid on the
photo/video/file/voice bubble (`UploadProgressRing.tsx`, new) — filling as
bytes actually go out, the "circle like WhatsApp" that was asked for. It
also retries each chunk independently with exponential backoff on a flaky
connection, and can resume, which the old path had neither of — this is
also the concrete fix for "slow internet."

**Failure handling — visible and recoverable, not just a toast:** if a
send or upload genuinely fails after retries are exhausted, the optimistic
bubble stays on screen with a small red "failed" indicator in place of the
usual sent/read ticks (`MessageStatus.tsx`, extended) and a faint red ring
around the bubble. Tapping the bubble (or the status icon) retries the
exact same send — re-running the same upload/insert against the same
content, not creating a duplicate message.

**No duplicates once the real message lands:** each optimistic bubble
carries a temporary `pending-<uuid>` id. On success, the DB insert's
returned row (via `.select().single()`) replaces the optimistic entry in
place — same slot in the timeline, no reorder or flicker. The realtime
subscription that also receives this same row moments later is a no-op
against it, since the existing realtime handler already dedupes by id and
the real id is already present in state by then.

### Files touched
- `src/types/chat.ts` — added `_sendStatus`, `_uploadProgress`,
  `_localPreviewUrl` to `DecryptedMessage` (all optional, client-only,
  never persisted — absent on every message that actually came from the
  DB, which is the overwhelming majority).
- `src/pages/Chat.tsx` — `handleSend`, `handleFileSelect`,
  `sendVoiceMessage` now build an optimistic bubble first; the actual
  send/upload logic was factored into two shared, retry-safe helpers
  (`attemptSendText`, `attemptSendMedia`) plus a `retryMessage` dispatcher,
  so first-attempt and retry always run identical logic. Imports
  `resumableUpload`.
- `src/components/chat/MessageBubble.tsx` — renders the local preview URL
  or progress ring for a still-sending media message; a failed message
  gets a destructive-tinted ring and is tappable to retry.
- `src/components/chat/MessageStatus.tsx` — extended with `sending`
  (spinner) and `failed` (tappable retry icon) states, alongside the
  existing sent/read ticks.
- `src/components/chat/MessageTimeline.tsx` — threads the new
  `onRetryMessage` callback down to each bubble.
- `src/components/chat/UploadProgressRing.tsx` — new, small SVG circular
  progress indicator (determinate when real progress is known,
  indeterminate spinner otherwise), respects reduced-motion.

### What did NOT change
- No backend/Supabase/RLS/edge-function change. `resumableUpload` and its
  `finalize-upload` edge function already existed and are already
  production-used by Gallery — Chat now calls the same, already-working
  path instead of a separate, weaker one.
- No change to E2E encryption — text is still encrypted before insert
  exactly as before; only the optimistic bubble shown locally (which
  already has the plaintext, since it's your own outgoing message) skips
  waiting for the round trip.
- No change to message semantics, disappearing-message behavior, reply/
  reaction/edit/pin behavior, or the realtime subscription itself.

## Verification

- `tsc --noEmit -p tsconfig.app.json` (vitest types excluded, same method
  as prior sessions): every file touched in this pass — `Chat.tsx`,
  `MessageBubble.tsx`, `MessageStatus.tsx`, `MessageTimeline.tsx`,
  `UploadProgressRing.tsx`, `types/chat.ts`, `GridMenu.tsx`, `MapView.tsx`
  — produces zero new genuine errors. The only remaining output on these
  files is the same pre-existing, repo-wide missing-`@types/react`
  artifact already documented in prior sessions' docs (present identically
  in dozens of untouched files — `Auth.tsx`, `Gallery.tsx`, `Groic.tsx`,
  `Us.tsx`, `ErrorBoundary.tsx`, every `ui/*.tsx` primitive, etc.) — not
  something this pass introduced.
- Confirmed via `grep` that `resumableUpload` is properly imported in
  `Chat.tsx` and that `MessageTimeline` passes `onRetryMessage` through.
- Confirmed the portal fix doesn't change GridMenu's props/behavior —
  same `onClose`, same content, same animation values, only the render
  target changed.

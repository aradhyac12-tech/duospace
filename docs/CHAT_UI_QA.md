# Chat UI QA — Phase 3

Manual test matrix for `pages/Chat.tsx` and the decomposed components in
`components/chat/`. Run on a real Android + real iOS device (WebView/Capacitor
behavior — especially keyboard, back button, safe-area, and pointer capture —
does not reliably reproduce in a desktop browser). No automated E2E harness
exists for this screen yet; this doc is the manual gate until one does.

Legend: ✅ pass criteria described inline. Log failures with device/OS
version, since several of these are WebView-version-specific.

---

## 1. Text message
- Send a plain text message → appears instantly (optimistic), sender-side
  right-aligned bubble, status icon progresses sent → delivered → read.
- Message decrypts correctly on both sender and receiver (E2E round-trip).
- `/silent` prefix suppresses the notification sound/haptic on the
  receiving device but still delivers and renders normally.
- Long text wraps, preserves newlines (`whitespace-pre-wrap`), bubble
  doesn't overflow 80% max-width.

## 2. Rapid messages
- Fire 10+ messages in quick succession (tap Send repeatedly, or paste+send
  in a loop) → no duplicates, order matches send order, no dropped sends.
- Double-tap Send on the same content within the dedup window
  (`sendDedup`/`createSendDedup`) → only one message is created.
- Consecutive messages from the same sender within 4 minutes visually group
  (`GROUP_GAP_MS`) — avatar/timestamp collapse, only last bubble in the
  group shows the tight corner radius.

## 3. Reply
- Swipe a bubble right past the reply threshold (44px) → haptic fires once,
  `ReplyPreview` populates, input focuses.
- Long-press → context menu → Reply does the same.
- Sent reply renders `QuotedMessage` with correct quoted sender name
  ("You" vs partner name) and correct quoted content.
- Tapping/jumping to a pinned or quoted message scrolls the right bubble
  into view (`msg-${id}` anchor).

## 4. Reaction
- Long-press or context-menu → React opens `MessageReactions` picker on
  the correct bubble only (`isReactingTo` scoped to one message id).
- Adding a reaction is realtime-visible on the partner's device without
  reload (`useReactionsChannel`).
- Reaction constraint prevents duplicate reactions from the same user on
  the same message (toggling replaces, not stacks).

## 5. Edit
- Context menu → Edit on own message only (not available on partner's
  messages) → composer switches to edit mode, placeholder changes,
  send button becomes a checkmark.
- Saving shows `edited_at` pencil icon on the bubble; canceling (back
  button / clearing text) leaves the original message untouched.

## 6. Delete
- Delete removes the message from both devices; no ghost bubble remains
  after realtime sync.
- Deleting a message that's currently quoted by a reply degrades
  gracefully (quoted content shows a safe fallback, not a crash).

## 7. Disappear
- Enable disappearing messages at each interval in `DISAPPEAR_OPTIONS`
  (10s test interval is fastest to verify).
- Bubble shows `DisappearRing` countdown; imminent-glow animation fires
  in the last 2.5s (`disappear-imminent`); exit uses the slow blur/shrink
  "evaporate" transition, distinct from the manual-delete pop.
- Message actually removes itself client-side at `disappear_at` without
  requiring a manual refresh, and stays gone after reload.

## 8. Attachment
- Image, file, and camera-capture pickers each launch the correct native
  picker and upload; failed upload shows retry, not a silent drop.
- Tapping a low-bandwidth/hidden image (`mediaVisible === false`) reveals
  it via `PhotoViewer` instead of auto-loading.
- Cancelling an in-flight attachment pick (backing out of the OS picker)
  leaves the composer in its prior state — no orphaned "sending" bubble.

## 9. Voice recording
- Press-and-hold mic button starts recording (`onPointerDown` +
  `setPointerCapture`); dragging the finger off the small button does
  **not** cancel the recording (this was a real prior bug — verify the
  regression stays fixed).
- Release → stop and send; drag-to-cancel / tap trash → discard, no
  message created.
- `onPointerCancel` (e.g., an incoming call interrupts the hold) cancels
  the recording cleanly.
- Waveform visualizer runs during recording and during playback; tapping
  the played waveform seeks (regression check — this previously threw
  silently because the click event wasn't passed through).

## 10. Scheduled message
- Compose text → open scheduler (via Hub long-press or grid menu) → pick
  a future time → message is **not** sent immediately, appears in a
  scheduled state, and delivers automatically at the chosen time even if
  the app was backgrounded/killed in between.
- Rate limiting (`scheduledMsgLimiter`) surfaces a clear retry-delay
  message rather than a silent failure when exceeded.

## 11. Love letter
- Grid menu → Love Letter → compose/send → renders with the distinct
  letter styling (💌 header line + body), not as a plain text bubble.
- Partner receives and can open it without needing special permissions.

## 12. Surprise
- Trigger via `ChatSurpriseHost` → overlay/effect plays without blocking
  the message input or freezing scroll.
- Respects `prefers-reduced-motion` (no forced motion-heavy surprise
  animation when the OS setting is on).

## 13. Offline
- Toggle device airplane mode, send a message → message queues locally
  (optimistic UI) with a visible pending/error state, does not silently
  vanish.
- Attempting an action that requires the network (call initiate, image
  upload) fails with a clear recoverable error, not a hang.

## 14. Reconnect
- Restore network after (13) → queued sends flush automatically, no
  duplicates on reconnect (`useReconnectRefetch` + `sendDedup` both
  guard this — verify together, not just individually).
- Typing indicator and unread counts resync correctly after a reconnect
  that happened mid-typing.

## 15. Reload
- Kill and relaunch the app mid-conversation → scroll position lands at
  the correct spot (last read / bottom), pagination (`PAGE_SIZE=200`)
  loads correctly, no duplicate or missing messages versus pre-reload
  state.
- Any in-progress states that shouldn't survive a reload (recording,
  unsent draft in edit-mode) are handled sanely — either restored or
  cleanly cleared, never left in a broken intermediate UI state.

## 16. Partner reconnect
- Partner goes offline mid-chat, comes back → their read receipts,
  reactions, and typing indicator resume live-updating without the local
  user needing to reload.
- Messages sent by the local user while the partner was offline show
  correct delivered→read transition once the partner reconnects.

## 17. Long press
- Long-press on a bubble opens `MessageContextMenu` anchored to that
  bubble only; does not simultaneously trigger the swipe-to-reply drag
  gesture (`useLongPress` + drag must not conflict on the same pointer
  sequence).
- Long-press on the Hub button opens the scheduled-message picker
  shortcut (existing feature — verify it isn't lost in any composer
  changes).

## 18. Keyboard open/close
- Opening the keyboard does not cover the composer or clip the last
  visible message; timeline auto-scrolls to keep the input in view.
- Closing the keyboard (via done/back, not just tapping away) restores
  scroll position sensibly, doesn't jump to top/bottom unexpectedly.
- Typing while a `Sheet`/dialog (disappear picker, clear-chat confirm) is
  open doesn't fight the keyboard for layout space.

## 19. Android back button
- Back button, in priority order, should: close an open sheet/dialog →
  close the grid menu/hub → clear an active reply/edit state → exit the
  screen. Verify each layer consumes back before it falls through to
  screen navigation (a single back press shouldn't skip a layer, e.g.
  jumping straight out of the chat while a reply is still staged).

## 20. iOS safe area
- Composer respects the bottom safe-area inset on notch/Dynamic Island
  devices (`pb-safe` on sheets, composer padding) — no controls sit under
  the home indicator.
- Rotation (if supported) doesn't reintroduce clipping under the
  safe area.

---

## Known-fixed regressions to re-verify (do not silently re-break)
- Voice waveform seek-on-tap (previously threw due to missing event arg).
- Voice recording cancel-on-finger-drift (previously cancelled on
  `pointerleave` without pointer capture).
- Duplicate OAuth/callback-adjacent send races — not chat-specific, but
  `sendDedup` exists specifically to guard rapid-tap/reconnect-storm
  duplicate sends; don't remove it while touching the composer.

## Out of scope for this pass
None — the full decomposition landed. `Chat.tsx` (2050 → 1284 lines) now holds
only state/effects/business logic (fetch, realtime subscriptions,
send/edit/delete, call setup, pagination, search, disappear timers) — the
layers it wires together live in `components/chat/`:

- `ChatHeader.tsx` — chat header, conversation status, search bar
- `MessageTimeline.tsx` — message timeline, date/unread separators, empty state
- `MessageBubble.tsx` — message bubble system (+ swipe-to-reply, long-press, disappear ring)
- `MessageComposer.tsx` — composer, recording state, reply state, editing state
- `CallOverlay.tsx` — in-call full-screen UI (error + active states)
- `VoiceMessagePlayer.tsx`, `PinnedMessageBanner.tsx` — supporting bubble pieces
- `types/chat.ts`, `lib/chatConstants.ts` — shared types/constants

Context actions (`MessageContextMenu`), attachment previews (hidden file
inputs + the attach-menu trigger), the feature hub (`GridMenu`), and the
encryption/privacy indicator (folded into the header's status line, since
it's one line of state-driven text rather than a distinct visual layer) are
still invoked directly from `Chat.tsx` — they were already separate
components before this pass; only the invocation sites live there, which is
appropriate for state-driven modal/sheet wiring.

None of this was build/typecheck-verified in-sandbox (no `node_modules` or
network access here). Every extraction was instead checked by: prop-by-prop
cross-reference against bound variables in `Chat.tsx`, a paren/brace/bracket
balance diff against the pre-extraction file (a pre-existing 1-paren
imbalance inside a string/comment was confirmed unchanged throughout, never
introduced), and an unused-import sweep after each step. Run your normal
build + typecheck before trusting this — that's the one thing this sandbox
categorically cannot do for you.

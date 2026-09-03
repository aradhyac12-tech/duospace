# Phase 7 — Flagship Interaction Redesign: QA & Audit

Scope: Peek Guard, App Lock, Biometric Unlock, Mood Detector, Mood History,
Security Dashboard, Surprise Mode (`SurpriseReveal` + `SurpriseScene3D`),
Code Surprise (`CodeSurpriseEditor` audited separately from
`CodeSurpriseFrame`), and semantic haptics across all of the above.

**No detection/security algorithm changed.** Peek Guard's threat scoring,
face-match thresholds, spoof heuristics, PIN hashing/verification (PBKDF2),
biometric API calls, and mood-inference math (`extractExpression`,
valence/arousal mapping, per-user distrust calibration) are all untouched.
Every change in this pass is presentation, state-exposure, input-handling,
or interaction-timing — not detection logic. Where an existing code comment
already documented a **prior** bug fix (e.g. `AppLockScreen`'s constant-time
PBKDF2 compare, `MoodDetector`'s opt-in gating), it was left as-is; no new
bug was found in the algorithms during this pass.

---

## 1. Peek Guard

| Change | File | Why |
|---|---|---|
| Semantic haptic on lock: `hapticWarning()` normally, `hapticError()` for `threatLevel === "critical"` (was blanket `hapticHeavy()`) | `PeekGuard.tsx` | Matches the "warning vs. error" semantic tier instead of one generic heavy buzz for every trigger. |
| `hapticSuccess()` on biometric unlock (was `hapticLight()`); `hapticLight()` added to manual "Dismiss" | `PeekGuard.tsx` | Recovery success now reads as a genuine "you're back in," not a neutral tap. |
| Auto-fire the native biometric prompt ~200ms after a lock appears (once per episode, guarded by a ref) | `PeekGuard.tsx` | The legitimate owner no longer has to tap anything on supported devices — the OS prompt is already up by the time they look at the screen. A stranger holding the phone still can't get past it; failing/cancelling biometric just leaves the lock exactly as before. |
| `aria-label` on the alertdialog summarizing the lock reason; autofocus on the primary recovery button ~50ms after the lock renders | `PeekGuard.tsx` | Screen-reader users get the same "reason + fastest path to recovery" that sighted users get, without hunting for the first actionable control. |
| Threat info stayed hidden by default; only `high`/`critical` show a small uppercase label, never the raw numeric score | *(unchanged — already correct)* | Existing behavior was already exposing threat level without severity theatrics; verified, not touched. |

**Not changed / considered and rejected:** Escape-to-dismiss. A privacy
lock is a security surface, not a generic modal — letting Escape bypass it
would undercut the point of the feature, so it was deliberately left out
even though it would have been the "expected" a11y pattern for a dialog.

### Peek Guard QA checklist
- [ ] Trigger a lock (low/medium threat) → screen goes opaque within one
      frame, haptic fires once, no flash-of-unlocked-content.
- [ ] Trigger a lock with `threatLevel: "critical"` → distinct (stronger)
      haptic fires; UI still shows the same calm copy, only the small
      "critical threat" label differs.
- [ ] On a device with biometrics enrolled: lock appears → OS biometric
      sheet appears automatically within ~200ms without any tap.
- [ ] Cancel the OS biometric prompt → lock screen remains, manual
      "Verify" and "Dismiss" buttons still work, no crash/loop, and the
      auto-prompt does **not** re-fire on its own.
- [ ] Screen reader (VoiceOver/TalkBack) announces the lock and its reason
      as soon as it appears (alertdialog role); focus lands on the primary
      button without extra swipes.
- [ ] Tap "Dismiss" (no biometric) → light haptic, rating prompt appears,
      "Real alert 👍 / False alarm 👎" both write feedback and haptic-confirm.
- [ ] `prefers-reduced-motion: reduce` → the pulsing shield / breathing
      animations stop (inherited automatically from `MotionConfig
      reducedMotion="user"` in `App.tsx` — verified still applies here).
- [ ] Rapid repeated triggers (e.g. someone keeps peeking) don't stack
      multiple biometric prompts or multiple haptic bursts per lock episode.

---

## 2. App Lock (PIN) + Biometric Unlock hook

| Change | File | Why |
|---|---|---|
| `hapticSuccess()` on first-time PIN set and on correct PIN | `AppLockScreen.tsx` | Previously silent — unlocking gave no tactile confirmation at all. |
| `hapticWarning()` on wrong PIN, `hapticError()` when the 5-attempt lockout engages | `AppLockScreen.tsx` | Distinguishes "you got it wrong" from "you're now locked out" instead of using the same feel (or nothing) for both. |
| `hapticSuccess()` on successful biometric verify | `useBiometricLock.ts` | Matches the App Lock PIN success feel — biometric and PIN unlock now feel like the same "you're in" moment. |

### App Lock QA checklist
- [ ] First run (no PIN set yet): enter 4 digits → success haptic, saved,
      unlocked.
- [ ] Correct PIN on a later run → success haptic, unlocked immediately.
- [ ] Wrong PIN → warning haptic + shake/error state, input clears after
      the existing 600ms delay.
- [ ] 5th wrong attempt in a row → error haptic + lockout countdown starts;
      no double-fire of both warning and error on the same attempt.
- [ ] Biometric unlock (Face/Touch ID) success → success haptic fires
      exactly once, screen unlocks.
- [ ] Biometric cancel/fail → no haptic, falls back to PIN entry as before.

---

## 3. Mood Detector

The biggest functional gap here was that a failed detection window gave one
generic "couldn't get a clear view" message no matter what actually went
wrong, and camera permission denial was silently swallowed (`catch {
setDetecting(false) }`, nothing shown to the user).

| Change | File | Why |
|---|---|---|
| `startDetection` now catches `getUserMedia` failures via the existing `explainGumError()` helper and renders a dedicated "Camera access needed / Camera unavailable" card with **Try again**, **Settings** (native only, denied only), and a manual-mood fallback | `MoodDetector.tsx` | "Handle camera permission denial elegantly" — was previously a silent dead-end. |
| Added lightweight per-window diagnostics: no-face count, multiple-face count, dark-frame count (via a cheap 16×16 average-luma sample, only taken on no-face frames), and model-load-failure count | `MoodDetector.tsx` | Distinguishes *why* a read failed instead of one generic message. |
| Post-scan message now branches: `model_failed` / `too_dark` / `multi_face` / `no_face`, each with an actionable one-line hint, plus quick manual-mood buttons right there | `MoodDetector.tsx` | No-face, multiple-face, and low-light are now handled distinctly, per spec, instead of collapsed into one bucket. |
| Added a **live** in-scan hint (updated once/second from the same counters) that surfaces multi-face/no-face *during* the 5s window, not just after it's wasted | `MoodDetector.tsx` | Faster recovery — a person can reposition mid-scan instead of finding out after the countdown ends. |
| Added `moodSource: "detected" \| "confirmed"` and numeric `confidencePct` (0–100), threaded through camera detection (starts `detected`), manual picks (`confirmed`, 100%), and 👍 feedback (upgrades to `confirmed`) | `MoodDetector.tsx` | "Clearly distinguish detected mood from user-confirmed mood" — previously there was no UI distinction at all beyond a hidden `lowConfidence` boolean. |
| Badge + copy changes: camera reads show a muted "Detected · ~NN%" pill and "Estimated from your expression, not a diagnosis"; confirmed reads show a "Confirmed" pill and "Saved to your mood log" | `MoodDetector.tsx` | "Never imply medical/psychological certainty" + "make confidence/probability information understandable" — a plain percentage + explicit non-diagnostic language, not a decorated confidence score. |
| Camera privacy disclaimer above the "Detect with Camera" button | *(unchanged — already present)* | Verified still accurate after the above changes (nothing new is persisted). |

### Mood Detector QA checklist
- [ ] **Permission denied** (deny the browser/OS prompt): card shows
      "Camera access needed" + explanation, **Try again** re-triggers the
      prompt, manual mood picker still works underneath. On native with
      `code: "denied"`, a **Settings** button deep-links to app settings.
- [ ] **Permission granted, camera works normally**: scan runs 5s, result
      shows a "Detected · ~NN%" pill, 👍/👎 feedback available; 👍 flips the
      pill to "Confirmed" and hides the feedback row.
- [ ] **Manual mood pick** (no camera): result shows a "Confirmed" pill
      immediately, no feedback prompt (nothing to confirm).
- [ ] **No face in frame** for most of the window: live hint reads "Can't
      find your face…" partway through; final message is the `no_face`
      copy with manual-pick buttons inline.
- [ ] **Two+ faces in frame** (e.g. testing with another person/photo):
      live hint reads "Multiple faces in view…"; final message is the
      `multi_face` copy.
- [ ] **Low light** (cover the camera / dim room): final message is the
      `too_dark` copy, distinct from the no-face copy.
- [ ] **Model load failure** (simulate by blocking the MediaPipe CDN):
      final message is "Detection couldn't load" — not blamed on lighting.
- [ ] Confidence number shown never exceeds a plain "~NN%" — no
      "scientifically detected," no diagnostic language anywhere in the copy.
- [ ] Closing the card mid-scan releases the camera (`stopCamera`) and
      clears all issue/hint state so reopening starts clean.

---

## 4. Mood History & Security Dashboard

Both audited; both were already in good shape for this phase's goals
(honest, non-alarming, no unearned certainty) and were **not substantially
changed**:

- `SecurityDashboard.tsx` already avoids raw threat scores in favor of
  plain-language summaries, already states its own detection limitations
  explicitly, and has no motion to gate. Left as-is.
- `MoodHistory.tsx` aggregates the same `confidence`/`feedback` columns
  `MoodDetector.tsx` was already writing before this phase — no schema or
  query changes were needed for the new `moodSource`/confidence-percent UI,
  since that's purely a display-layer addition on top of the same data.

---

## 5. Surprise Mode (`SurpriseReveal.tsx` + `SurpriseScene3D.tsx`)

Reworked to satisfy the full anticipation → interaction → reveal → content
→ completion sequence **without** any of it gating the actual content, and
without leaving reduced-motion or keyboard users behind.

| Change | File | Why |
|---|---|---|
| `useReducedMotion()` + a `skipped` state combine into one `instant` flag; every staged transition (`containerVariants` stagger/delay, `growUp` variants, backdrop opacity, the CSS `max-width/max-height` transition) branches to duration 0 when `instant` is true | `SurpriseReveal.tsx` | Satisfies "respect reduced motion" for **all** motion sources, not just the framer-driven ones already covered by `MotionConfig`. The raw Tailwind `transition-[max-width,max-height]` class was previously untouched by `MotionConfig` — now explicitly gated. |
| New **Skip** button (top-left of the card header, visible until intro completes) calls `skipIntro()` → `hapticSelection()` + sets `skipped` | `SurpriseReveal.tsx` | Explicit, discoverable "provide a way to skip animation" — previously there was none. |
| Pointer-driven 3D tilt (`rawX`/`rawY` → springs) now no-ops under `instant` | `SurpriseReveal.tsx` | A reduced-motion user moving their mouse/finger shouldn't still trigger spring-physics tilt — `MotionConfig`'s `reducedMotion="user"` does **not** cover manually-driven `useSpring`/`useTransform` values, only `animate`-prop transitions, so this needed explicit gating. |
| `role="dialog"`, `aria-modal="true"`, `aria-label` naming the surprise; `Escape` key closes; focus moves to the close button on open (instantly if `instant`, ~120ms delay otherwise so it doesn't fight the entrance) | `SurpriseReveal.tsx` | Keyboard/screen-reader accessibility — previously no dialog semantics, no keyboard dismissal, no focus management at all. |
| `SurpriseScene3D` only mounts when `variant.richScene && expanded && !instant` (was `variant.richScene && expanded`) | `SurpriseReveal.tsx` | "Avoid excessive particle effects" + reduced-motion: the WebGL particle field is now skipped entirely for anyone who asked for less motion or hit Skip, not just visually suppressed. |
| Particle count `220 → 140`; render loop now pauses (`cancelAnimationFrame` + `clock.stop()`) on `visibilitychange` and resumes on return | `SurpriseScene3D.tsx` | Performance: fewer points, and zero GPU/CPU cost while the tab/app isn't visible instead of rendering an invisible scene forever. |
| `hapticLight()` added to Expand and Close buttons | `SurpriseReveal.tsx` | Selection/navigation-class actions previously had no tactile feedback at all in this component. |

**Content-delay guarantee (verified, not changed):** `CodeSurpriseFrame`
(the sandboxed iframe with the actual surprise content) is mounted in the
DOM at the same time as the rest of the card, just wrapped in a
`motion.div` whose *opacity/blur* animates — the iframe itself starts
loading/executing immediately regardless of `instant`/reduced-motion, so
skipping or disabling the animation never delays when the content is
actually ready. This was true before this pass and remains true after it.

### Surprise Mode QA checklist
- [ ] Normal motion: intro plays root-glow → card → content in a visible
      stagger (~0.2s apart), completes in roughly 1.5–2s.
- [ ] `prefers-reduced-motion: reduce` (OS-level setting): surprise appears
      fully formed on the very first frame — no stagger, no blur-in, no
      tilt on pointer move, no WebGL particle field even when expanded.
- [ ] Tap **Skip** during the intro: card snaps to its final state
      immediately, `hapticSelection()` fires once, Skip button disappears.
- [ ] Tab to the surprise while it's open: focus starts on the Close (X)
      button; `Escape` closes it from anywhere in the dialog.
- [ ] Screen reader announces "Surprise: {title}" as a dialog when it opens.
- [ ] Expand → richScene surprise: particle field renders, animates
      smoothly, **stops** when you switch tabs/apps and **resumes** when
      you come back (check via a JS-side frame counter or GPU usage, not
      just visually).
- [ ] Close and reopen a different surprise back-to-back: `skipped`/`introDone`
      reset per-surprise — the second surprise still gets its own intro
      (doesn't inherit "already skipped" from the first).
- [ ] Low-end/throttled device: 140-particle field doesn't drop the
      surprise's own open/close/skip interactions below 60fps-equivalent
      responsiveness (interactions aren't blocked by the WebGL frame).

---

## 6. Code Surprise: Editor vs. Frame (audited separately, as requested)

### `CodeSurpriseFrame.tsx` — audited, unchanged
19-line sandboxed `<iframe sandbox="allow-scripts" srcDoc=...>`. Already
minimal and correctly scoped: `allow-scripts` **without** `allow-same-origin`
means injected code can run but can't escape the sandbox or touch the
parent app/localStorage/cookies. No visual or interaction changes needed —
this component's whole job is "render the document," and it already does
only that, immediately, with no artificial delay. Left as-is.

### `CodeSurpriseEditor.tsx` — reworked for efficiency, per the brief
The instruction was explicit: **functional and efficient, not merely
visually impressive.** All changes below are workflow/friction fixes to
the existing plain-`<textarea>` editor, not a visual overhaul:

| Change | Why |
|---|---|
| **Tab-to-indent**: `Tab` (without Shift) inserts two spaces at the cursor and restores cursor position, instead of the browser's default "jump focus to the next control." `Shift+Tab` is left alone so keyboard users retain a way to tab *backward* out of the field. An `sr-only` hint (`aria-describedby`) documents this on all three textareas. | Previously, indenting a nested tag/rule required manually typing spaces — the single biggest everyday friction point in a plain-textarea "code editor," and directly what "functional and efficient" was asking for. |
| **Cmd/Ctrl+S saves** from anywhere in the editor (one `keydown` listener attached once per editor session, dereferencing a `saveSurpriseRef` so it isn't torn down/re-added on every keystroke) | Standard editor muscle-memory; avoids reaching for the Save button on every iteration while testing a surprise. |
| **Unsaved-changes guard**: a cheap dirty-check (`title/html/css/js/maxViews` vs. a `baselineRef` snapshot taken when the editor opened or last saved) gates the Close button and `Escape` behind a confirm dialog ("Keep editing" / "Discard") instead of silently discarding work | Closing mid-edit previously lost everything with zero warning. |
| **Delete confirmation**: deleting a surprise now opens an `AlertDialog` ("This can't be undone...") instead of deleting on a single tap; confirm/cancel both haptic-confirm | Delete is a genuinely destructive, high-commitment action that previously fired on one tap with a generic `hapticMedium()` — now matches the "high-commitment actions" haptic tier (`hapticWarning()` on both opening the prompt and on the confirmed delete) and gets a real confirmation step. |
| **Save button dirty indicator**: a small amber dot appears on Save while there are unsaved changes, clears on successful save | Cheap, always-visible answer to "do I need to save?" without opening a dialog to find out. |
| `hapticSuccess()` on a save that actually succeeds, `hapticWarning()` on a save that fails (previously: unconditional `hapticMedium()` regardless of outcome) | Haptic now reflects what actually happened instead of firing identically for a successful and a failed save. |
| `applyPreset` now uses `hapticSelection()` (was `hapticLight()`) | Matches the "selection" semantic tier — picking a preset from a horizontal list is a selection action, not a generic light tap. |

**Deliberately not done:** syntax highlighting, line numbers, a full code
editor library (CodeMirror/Monaco). The brief asked for "functional and
efficient," and pulling in a heavy editor dependency would cut against
that for a mobile-first surface whose actual content is short HTML/CSS/JS
snippets — the friction fixes above (indent, save shortcut, don't-lose-work
guard) address the real efficiency gap without the bundle-size/complexity
cost.

### CodeSurpriseEditor QA checklist
- [ ] Open editor, type in the HTML textarea, press `Tab` → two spaces
      inserted at cursor, cursor lands right after them, focus stays in
      the textarea.
- [ ] Press `Shift+Tab` in a textarea → focus moves to the previous
      control (browser default), no character inserted.
- [ ] Edit anything, press `Cmd/Ctrl+S` → save fires, success haptic,
      editor closes, list refreshes with the update.
- [ ] Edit anything, tap the Close (X) button → "Discard changes?" dialog
      appears; "Keep editing" returns to the editor with content intact;
      "Discard" closes and reverts to the pre-edit state.
- [ ] Open editor, close immediately with **no** edits → closes instantly,
      no confirm dialog (nothing to lose).
- [ ] Tap Delete on an existing surprise → confirm dialog appears (not an
      immediate delete); "Cancel" leaves it untouched; "Delete" removes it
      and refreshes the list.
- [ ] Trigger a save failure (e.g. offline) → warning haptic, destructive
      toast, editor stays open with content intact (not silently closed).
- [ ] Dirty dot on Save button appears after any edit, disappears
      immediately after a successful save.
- [ ] Screen reader reads each textarea's `aria-label` ("HTML source" /
      "CSS source" / "JavaScript source") and the Tab-indent hint via
      `aria-describedby`.

---

## 7. Haptics — semantic usage summary

Existing `src/lib/haptics.ts` already provided a full semantic vocabulary
(`hapticSelection`, `hapticLight/Medium/Heavy`, `hapticSuccess/Warning/Error`,
`hapticSend`, etc.) — this phase's work was mapping call sites onto the
*correct* category rather than adding new primitives.

| Category | Where used after this pass |
|---|---|
| Selection | Preset picking (`CodeSurpriseEditor`), Skip-intro (`SurpriseReveal`) |
| Navigation / light tap | Expand/Close surprise, Peek Guard manual dismiss, config toggles |
| Send | *(unchanged — chat send flow, not touched this phase)* |
| Success | Correct PIN, biometric unlock (App Lock + Peek Guard), successful code-surprise save |
| Warning | Wrong PIN, Peek Guard lock (non-critical), failed save, opening a delete/discard confirmation |
| Error | Lockout engaged, Peek Guard lock (critical threat) |
| High-commitment | Delete-surprise confirm (`hapticWarning`, deliberately reused rather than adding a new "destructive" primitive that doesn't exist in the library) |

**Deliberately not instrumented:** per-character typing in the code editor
textareas, per-frame surprise animation ticks, mood-detector countdown
ticks, hover/hover-adjacent states. The brief explicitly said not to wire
haptics to every DOM event — these are exactly the high-frequency,
low-meaning events that would turn tactile feedback into noise.

---

## 8. Cross-cutting checks

- [ ] **No detection/security regressions**: run the existing Peek Guard
      threat-scoring test cases (if any) and confirm identical
      lock/no-lock decisions before/after this phase — only presentation
      changed.
- [ ] **Bundle/perf**: `SurpriseScene3D` remains lazy-loaded
      (`lazy(() => import(...))`) and now additionally never mounts at all
      under reduced-motion/skip — net perf win, not a regression.
- [ ] **No new console errors** across: Peek Guard lock/unlock cycle, Mood
      Detector full flow (permission denied → granted → detect → feedback),
      Surprise open/expand/skip/close, Code Surprise create/edit/delete.
- [ ] **Dark mode**: all new UI (camera-issue card, detected/confirmed
      badges, Skip button, delete/discard dialogs) uses existing
      `bg-card`/`bg-muted`/`text-muted-foreground`/`bg-destructive` tokens —
      no hardcoded colors introduced, so theming is inherited for free.
- [ ] **Safe-area / mobile viewport**: no new fixed-position elements were
      added outside the existing safe-area-aware containers (`safe-top`,
      `safe-bottom`, `env(safe-area-inset-*)` already in use).

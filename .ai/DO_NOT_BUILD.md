RESTORED 2026-09-19 from this project's own prior session content (was
missing from this snapshot — see .ai/KNOWN_ISSUES.md KI-01). Real
authored history, not a placeholder; spot-check before treating any
specific line as still current.

Canonical do-not-build list. This file is load-bearing the same way
`.ai/DO_NOT_CHANGE.md` is — code review should check against it, not
just against a one-time brief.

## Absolute — no version of these, ever

- Cheating, lying, or deception detection from any signal (face, voice,
  text, timing, or any combination). Human lie-detection accuracy is
  ~54% (near chance) even for trained professionals — no automated
  system has been shown to do meaningfully better on this task.
- Facial-expression-as-emotion-fact features — no reliable cross-context
  mapping exists from facial configuration to discrete emotion.
- Voice-stress or voice-based emotion/deception features — essentially
  no evidence base.
- A single relationship-health score or compatibility percentage/verdict
  — no scientific basis exists for either.
- Any feature that processes a partner's signal (messages, location,
  mic, camera, behavior) without that partner's own active, visible
  participation and specific consent.
- Cloud-default processing of raw microphone, camera, or video data.
- Relationship destiny prediction, breakup recommendation, "perfect
  partner" prediction.
- Secret recording, secret microphone/camera activation, automatic
  camera activation during calls (including for DuoAutoAnswer —
  audio-only by design).
- Partner surveillance, hidden monitoring, automatic relationship
  judgments presented as fact.

## Requires a real evidence upgrade before reconsidering

- Multimodal signal fusion for any relationship-insight feature — no
  evidence that combining several individually-weak signals produces a
  reliable strong one for this domain.
- Passive typing-cadence/response-latency signals as anything more than
  a minor, clearly-labeled input.

## How to add to this list

Any future feature idea that fails an evidence-tier classification, or
crosses the trust/surveillance boundary, gets added here rather than
quietly dropped — keep the reasoning attached so a future session
doesn't re-propose it without seeing why it was rejected.

# Mood detection: which "database" to use (research, 2026-10-02)

## Decision
Do NOT ship or train on a third-party facial-expression image dataset. Build a **per-person, on-device mood profile**
from the user's own 👍-confirmed reads (`src/lib/moodProfile.ts`, `moodProfileStore.ts`). Keep MediaPipe blendshapes
(Apache-2.0) as the signal.

## Why (sources: arXiv 2211.08030 table 34; arXiv 2503.20428; arXiv 2209.15402; HSEmotion/EmotiEffLib pages)
| Dataset | Size | Licence (per the 2022 face-image-quality survey) | Note |
|---|---|---|---|
| AffectNet | ~440k, 8 classes + valence/arousal | non-commercial | best-known; population models reach only ~61-63% on 8 classes |
| RAF-DB | ~30k, 7 basic (+11 compound) | non-commercial | ~87-89% reported for 7 classes |
| FER2013 | ~35k, 48x48 grey | no licence stated | noisy labels, low res |
| MMI / MUG | small, lab | academic / non-commercial | posed |
DuoSpace has paid plans (monetization/entitlements migrations), so non-commercial data cannot be used to train anything
that ships. Public models fine-tuned on AffectNet (e.g. HSEmotion, code Apache-2.0) may inherit the dataset terms for
their WEIGHTS — NOT verified; get a licence read before ever bundling one.

## Scientific caution (not a licence issue)
Faces do not reliably reveal inner mood; even the best 8-class models are ~60% on in-the-wild data. That is why reads
stay user-confirmed (👍), low-margin reads are dropped (`topMoodWithMargin`), and nothing is stored without consent.

## What was built (v3.20.0)
- Resting baseline learned across sessions (EMA), blended with the per-session one (old code: per-session only).
- Per-mood prototypes (running mean of feature deltas) from 👍 reads; after 3 confirmations of a mood the rule score is
  nudged toward it. Weight <= 40%, Neutral untouched, delta space (camera/lighting robust).
- Storage: AES-GCM `secureStorage`, per user, wiped on sign-out, never uploaded, never in telemetry/mood_logs.
- 6 unit tests (`src/test/moodProfile.test.ts`) pass under a transpile + shim run; not under real vitest.

## Not done / next
- No accuracy evidence: there is no labelled data of this user population here. Measure on-device: log 👍/👎 rate before
  vs after profile has >=3 samples per mood (counts only, local).
- Optional research-only benchmark: evaluate the rule scorer on AffectNet/RAF-DB offline (never ship) to tune thresholds;
  needs network + dataset access request + licence compliance.
- If a shipped learned model is wanted: license-clean options are training on own consented data, or a model with a
  verified permissive data+weights licence.

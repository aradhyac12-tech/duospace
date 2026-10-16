# Peek Guard v2 — recovery, dark rooms, tracking, storage

## Root causes fixed
| Symptom | Cause | Fix |
|---|---|---|
| Had to tap to recover | `tick()` returned early during the post-lock cooldown (8s+, growing per lock), so auto-unlock never ran while locked | Cooldown now only blocks *new* locks; scanning continues while locked |
| Stuck in dim light | Lock side relaxed the threshold for low light, unlock side used the strict one | Unlock uses the same light-aware margin as the lock |
| Blind in the dark | Frame quality ×0.3 sat on the quality gate → no breaches, no recovery | Worker repairs dim frames (gamma + levels), face brightness counts, quality penalty much smaller when repaired |
| Owner flagged as stranger | Per-frame classification | `lib/faceTracker.ts`: identity per track, EMA margin, hysteresis |
| Stranger ducks out → instant unlock | No identity across frames | Stranger "ghost" blocks unlock for 800ms |
| Profile could vanish | Single IDB record, no integrity check | v2 codec + checksum + backup record + native mirror + persistent-storage request |
| Passive learning could loosen security | `selfSimFloor` recomputed over adaptive samples; FIFO evicted enrollment samples | Anchors protected; floor measured on anchors only; adapt is rate-limited + de-duplicated |

## New files
- `src/lib/faceTracker.ts`, `src/lib/lowLight.ts` (+ tests in `src/test/`)

## No new user settings
Everything here runs automatically in the background: frosted-glass cover, low-light boost, auto biometric fallback, tracking, storage hardening. (The only user-visible controls are the pre-existing Peek Guard ones.)

## Recovery order while locked
1. Auto face (ring shows progress; dim/dark need more frames + dwell; spoof locks need liveness)
2. Auto biometric — ~200ms for stranger locks, ~400ms in the dark, 1.8s otherwise (deferred while the face scan is mid-confirmation)
3. Auto PIN pad when there is no biometric hardware
4. Manual: Biometric / Scan my face / Use PIN / Try automatic scan again

## Needs a rebuild
`android/.../public/assets/*.js` are stale build output. Run `npm run build && npx cap sync` before testing on device.

## Face storage, phone-style (v2.1)
- `lib/privacy/secureKey.ts`: template sealed with a random AES-256 key held in Android Keystore / iOS Keychain (via capacitor-native-biometric credentials). Falls back to deviceVault on web. Existing profiles upgrade on next load.
- `lib/ownerAuth.ts`: adding, replacing or deleting face data needs device biometric first.
- Deleting the profile also destroys the keystore key.
- Manual face scan pauses 30s after 5 failures (biometric/PIN still work).
- Quick re-locks (<5s after an unlock) no longer skip the cover; the old toast-and-auto-dismiss path was a bypass.
- Android `allowBackup` is already false, so templates are not copied to cloud backups.

## v2.2 — smoother lock, quicker/more accurate unlock, better enrollment
- Lock screen: success state (green ring + check + "Welcome back") before the cover leaves; status text cross-fades; honours reduced-motion.
- Unlock speed: locked-state polling ~2x faster (min 100ms); matching uses cached vector norms (one dot product per sample instead of three passes).
- Enrollment: refuses to capture in dim light, with eyes closed, or while moving; after capture, `lib/enrollmentQuality.ts` drops outlier samples (e.g. someone else walking into frame), always keeps at least one sample per pose, and reports a quality grade.

## v2.3 — research-driven changes
Sources: Apple Face ID Security Guide / support.apple.com "Facial matching security";
Android CDD + source.android.com biometric docs; capacitor-native-biometric README.

Implemented
- **Learned samples expire** (`lib/templateLifecycle.ts`): passively-learned samples older than 45 days are dropped; anchors never expire. (Face ID: learned data is used for a finite number of matches then discarded.)
- **Near-miss + stronger factor learning**: while locked we keep the latest owner-looking frame; if you then unlock with biometric/PIN within 20s, that frame is learned (margin >= -0.10, still needs eyes open + facing camera). (Face ID: failure followed by passcode augments the template.) Helps exactly the dark/odd-lighting cases that were failing.
- **Stronger factor required periodically**: after 7 days without a biometric/PIN unlock, auto face unlock pauses until you confirm once. Only enforced if a PIN or biometric exists.
- **Weak Android face biometric guard**: if the only biometric is Android "face authentication" (often Class 2, photo-spoofable per Android docs), it is not auto-offered to clear a stranger/spoof lock; PIN is shown instead.

Not implemented (need model files / re-enrollment; recommended next)
1. **Real face-embedding model.** Matching today is cosine over normalised MediaPipe landmark geometry, which is a weak identity signal compared with a trained embedder. Reported figures (third-party, unverified): MobileFaceNet ~4 MB, ~35 ms CPU, ~99.3% LFW; DeepFace's benchmark found alignment can add up to 6% and detection up to 42% accuracy. Needs: an ONNX/TFLite model file, onnxruntime-web (or TFLite), 112x112 aligned crops from 5 landmarks, an `embedVersion` field on the profile, and re-enrollment.
2. **Passive anti-spoof model** (MiniFASNetV2-SE, 0.6-1.8 MB ONNX, ~98% reported accuracy, dual-scale 2.7x/4.0x crops at 80x80). Replaces the current blink/texture heuristics.
3. **Roll alignment** of landmarks before embedding (changes the embedding space, so do it together with #1).

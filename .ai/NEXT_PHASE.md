> **Superseded (2026-09-23):** DuoSpace calling is now self-hosted only (WebSocket signaling + LiveKit). Mentions of the previous provider below are historical. Current architecture: `docs/calling-architecture.md`; migration record: `docs/CALLING_MIGRATION_DAILY_TO_SELF_HOSTED.md`.

> **Gate (Phase 1.6):** do not start Relationship Intelligence V1 until KI-20
> (lockfile) is fixed and `npm ci`, lint, `tsc`, the test suite and the build
> have actually been run green, and KI-21/22/23/24 have an owner's decision.
> **Update (Phase 2A, 2026-09-23):** the owner explicitly directed Phase 2A
> to proceed despite this gate rather than wait on network access that has
> never materialized in this sandbox across any phase. It shipped with the
> same isolated-`tsc` verification standard the project has used
> throughout, not the originally-intended `npm ci`/lint/vitest/build gate.
> That gap is real and is called out in this phase's own final report — it
> is not silently resolved by this note.

NEXT PHASE: PHASE 2B — RELATIONSHIP AI, remaining P0 self-report scope —
see the queue below. Phase 2A (Values / Expectations / Communication
Reflection, local-rule provider, explicit sharing) is DONE as of
2026-09-23 — see `.ai/PHASE_STATUS.md` and
`docs/PHASE_2A_RELATIONSHIP_INTELLIGENCE_V1_FINAL_REPORT.md`.

## Phase 2B candidates (not started — explicitly out of Phase 2A's scope)
- A second, better provider behind the SAME `RelationshipAIProvider`
  interface (still LOCAL_MODEL, still no cloud) — the interface and
  registry (`src/lib/relationship/registry.ts`) were built for this;
  nothing else should need to change.
- A "compare with your partner" view for shared values/expectations
  (brief §10: differences only, never a ranking) — `relationship_shares`
  already carries everything needed to build the read side; nothing
  server-side is missing.
- Real device/runtime verification of everything in Phase 2A (nothing
  here has ever run against a live Supabase project or a device — same
  standing limitation as every other phase).
- Expiry/cron sweep for `relationship_shares` rows past `expires_at` — the
  RLS SELECT policy already hides them from the recipient, but the rows
  themselves are not cleaned up yet.

**File-completeness note (recurring — see `.ai/KNOWN_ISSUES.md` KI-01):**
as of Phase 1.5 (2026-09-19), `PROJECT_CONTEXT.md`, `DO_NOT_CHANGE.md`,
`IMPLEMENTATION_RULES.md`, `NATIVE_PROJECTS.md`, `DO_NOT_BUILD.md`, and
`FUTURE_ROADMAP.md` have been restored from real prior content — the 19
scientific-spec files and their final report are still missing and were
not restored this pass (deprioritized for a production-verification
pass specifically).

before (or during) Phase 2, not silently re-derived from memory again.

## Phase 1 (Privacy, Consent & Local-First AI Foundation) is done

See `.ai/PHASE_STATUS.md` and
`docs/PHASE_1_PRIVACY_CONSENT_LOCAL_AI_FINAL_REPORT.md` for full detail.
Summary: data classification, consent management (server-of-record +
DB-enforced), the privacy gate pipeline, the AI insight contract + safety
validator, a local-processor interface, local encrypted storage (software
AES-GCM, explicitly NOT hardware-backed — see `.ai/KNOWN_ISSUES.md`
KI-02), and one new settings UI page all exist and are real. No
relationship-AI feature was built — that was never this phase's job.

## Still-open security queue (blocking — do not start Phase 2 on top of these)

0. **NEW, P0, from Phase 1.5**: `package.json`/`package-lock.json` are
   out of sync for `livekit-client` — `npm ci` cannot succeed in ANY
   environment until someone with real npm registry access runs
   `npm install` and commits the regenerated lockfile. See
   `.ai/KNOWN_ISSUES.md` KI-07. This blocks literally everything else
   that depends on a working build (lint, typecheck, tests, build).
0.5. **NEW, from Phase 1.5**: `MoodDetector`, `useBackgroundMoodDetection`,
   `LipReadingOverlay`/`useLipReading`, and `PeekGuard` don't route
   through the Phase 1 privacy/consent system — the new
   `CAMERA_ANALYSIS`/`MICROPHONE_ANALYSIS` toggles don't actually gate
   them yet. Should be closed before Phase 2 adds more features that
   assume the consent system is the real gate for camera/mic access.
   See the Phase 1.5 final report §11.

1. Remaining items: encryption lifecycle threat model, session/
   clock-skew handling, a general telemetry review beyond the Phase 1
   client-side redaction pass, TypeScript `any`/unsafe-cast audit.
   (Full edge-function audit and push-token/device-table RLS are now
   done — see `docs/PHASE_4_SECURITY_AUDIT.md` §19–20 — neither found
   anything left to fix beyond what's already landed.)
2. A real discrepancy matrix: every claim in the ~50 files under `docs/`
   vs actual source (only spot-checked so far).
3. First environment with actual network/DB/device access should run:
   `npm ci`, `npm run lint`, `tsc`, `npm test`, `npm run build`,
   `supabase db reset` + `supabase db diff`, the manual RLS attack
   scenarios from `docs/PHASE_4_SECURITY_AUDIT.md` §13, AND this phase's
   own new migration/triggers/tests — none of this has ever actually run
   against a live instance in any snapshot seen so far.
4. The "Allow public access" Realtime dashboard toggle (manual,
   Aradhya-only action — see `docs/PHASE_4_SECURITY_AUDIT.md` §18) —
   unknown whether this has been done yet.

Everything from the previous queue (`invite_links` entropy,
`partner_requests` WITH CHECK, `finalize-upload` bucket allowlist,
Realtime channel authorization code, `send-push` recipient authorization)
is fixed in code — see `docs/PHASE_4_SECURITY_AUDIT.md` §15–19.

## Then: Phase 2 — Relationship AI, P0 tier only

Per `.ai/FUTURE_ROADMAP.md` (if present in your snapshot) / the original
roadmap: start narrow. Self-report check-ins (satisfaction, responsiveness,
appreciation) using the AI Output Contract UI, built as the first real
`LocalAIProcessor` implementation and the first real `AIInsight` producer.
Do NOT attempt compatibility/conflict/mood features simultaneously — they
depend on real usage data from this simpler feature to be worth building
at all. Read `.ai/AI_OUTPUT_CONTRACT.md`, `.ai/AI_SAFETY_SPEC.md`,
`.ai/CONSENT_MODEL.md`, `.ai/LOCAL_AI_ARCHITECTURE.md`, and
`.ai/DO_NOT_BUILD.md` before starting — and confirm `DO_NOT_BUILD.md`
actually exists in your snapshot first; if not, treat the feature freeze
list from the original Phase-0.5 brief as still binding until it's
restored.

## Calling migration (parallel track, not blocking Phase 2)

Self-hosted (LiveKit) calling is wired end-to-end by static analysis,
never runtime-verified. Daily stays the default. Next environment with
real Supabase + LiveKit + device access should run the physical-device
procedure in `docs/calling-architecture-v2.md` Phase 2 §18. Unrelated to
this project's own "Phase" numbering above — different track, same repo.

## Calling migration — after the remediation pass (2026-09-18)

1. `npm install` in a networked environment (fixes the broken
   package-lock.json — nothing calling-related, or anything else, can be
   build-verified until this happens).
2. Decide whether to wire WebSocketSignalingEngine into CallContext.tsx's
   accept/cancel flow (the post-wake coordination role — see
   docs/calling-architecture-v2.md's P0-3 finding for why this is NOT the
   same as "make WS primary for waking the callee", which is not
   something this app should do). Real production-code change, deserves
   its own pass with live two-device testing available.
3. Physical-device test procedure (calling-architecture-v2.md §18).
4. Then: P1-20 telemetry semantic rename and the other open P1 items
   listed in that doc's "P1 findings still open".

## Calling migration — after Phase 3 (2026-09-19)

1. npm install in a networked environment (still the standing blocker —
   nothing calling-related has ever been build- or runtime-verified).
2. Deploy infrastructure/signaling + set VITE_SIGNALING_URL in a real
   environment, then physical-device test the full CALLER->WS invite->
   CALLEE->WS accept->LiveKit token->same room->WebRTC->remote audio path
   — this is the actual moment callSignalingBridge.ts's code stops being
   inert and needs real verification.
3. If reconnect-within-a-call is tested and found to need it: replace
   sessionId=callId with a true per-attempt generation counter (see
   docs/calling-architecture-v2.md's "Known simplification").
4. Only after 1-3: Calling Phase 4 (latency optimization) — explicitly
   out of scope until the above is real.

## Calling track — next: CALLING PHASE 5 (2026-09-20)
Real-device + real-network latency benchmarking, Daily vs self-hosted. NO
architecture changes first. Prerequisites and matrix:
`docs/CALLING_PHASE_4_AUTHORITATIVE_SIGNALING.md` §R/§S (apply migration,
deploy single gateway + LiveKit, verify TURN via
`infrastructure/deployment/ENVIRONMENTS.md`, run real npm ci/vitest/tsc/lint).

## After Phase 2B (2026-09-23) — required before any multimodal work
1. Download weights on an unrestricted machine, publish to the DuoSpace model origin, pin SHA-256 + sizes in `localModel/manifest.ts`.
2. Run `runEvaluation(localModelProvider)` in a real browser (WebGPU + WASM); all gates must be 0; record load/first/avg latency, memory, failure rate.
3. Native runtime plugin (llama.cpp / MediaPipe) implementing `LocalModelRuntime` for Android/iOS, then device evaluation.
4. Only then consider promoting local-model-v1 (isProduction) — still with local-rule-v1 fallback. See docs/PHASE_2B_LOCAL_AI_FINAL_REPORT.md.

## Phase 2D (after 2C, 2026-09-23)
Pin artifact → web eval + p50/p95 → evidence-based threshold → llama.cpp Capacitor plugin → S24 Ultra + low-end device eval → promotion decision. E2E cloud only with attested TEE. See docs/PHASE_2C_REAL_LOCAL_AI_AND_E2E_ROUTING_REPORT.md.

## After Phase 2D (2026-09-23)
Next phase remains LOCAL AI STABILIZATION: obtain artifact on an unrestricted machine → pin → run realModel.eval → browser test → llama.cpp plugin → device measurements. No new AI features until §31 preconditions hold. See docs/PHASE_2D_REAL_LOCAL_AI_FINAL_REPORT.md.

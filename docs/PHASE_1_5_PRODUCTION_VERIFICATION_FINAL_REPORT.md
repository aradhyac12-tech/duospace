> **Superseded (2026-09-23):** DuoSpace calling is now self-hosted only (WebSocket signaling + LiveKit). Mentions of the previous provider below are historical. Current architecture: `docs/calling-architecture.md`; migration record: `docs/CALLING_MIGRATION_DAILY_TO_SELF_HOSTED.md`.

# DuoSpace — Phase 1.5: Production Verification — Final Report

**How to read this report:** every status below is one of PASS (actually
executed, succeeded), FAIL (actually executed, failed), BLOCKED (could
not be executed in this environment — network/DB/device access), or NOT
VERIFIED (not attempted this pass, or requires a manual step outside
code). No status in this document is inferred from "the code looks
right" alone. Where a finding is new to this pass, it says so; where it
restates a prior pass's finding, it cites where that finding actually
came from rather than re-deriving or duplicating it.

## 1. Repository Baseline

Reconciled `package.json`, `package-lock.json`, `README.md`,
`.ai/*.md`, relevant `docs/*.md`, Supabase migrations, edge functions,
`src/lib/callEngine`/`signalingEngine`, call hooks/context, the Phase 1
privacy/consent/AI foundation, and native source. One genuinely new,
serious finding: the dependency/lockfile P0 below. Everything else
reconciled cleanly against what prior passes already established — see
`.ai/CURRENT_STATE.md`'s full history for the complete prior record
(security audit findings §1–20 of `docs/PHASE_4_SECURITY_AUDIT.md`,
Phase 1's privacy foundation, the calling-architecture scaffold).

## 2. Repository Governance / AI Context Integrity

Confirmed missing at the start of this pass: `PROJECT_CONTEXT.md`,
`DO_NOT_CHANGE.md`, `IMPLEMENTATION_RULES.md`, `NATIVE_PROJECTS.md`,
`DO_NOT_BUILD.md`, `FUTURE_ROADMAP.md` — all six. Restored this pass
from real prior-session content (each file's own header states this
plainly and flags it as worth spot-checking against current source
rather than presenting it as freshly re-verified). Not fabricated —
these are files this project's own history actually produced earlier;
they simply didn't survive into this snapshot, a recurring pattern
tracked as `.ai/KNOWN_ISSUES.md` KI-01. The 19 scientific-spec files and
their final report remain missing — not restored this pass (out of
scope for a production-verification pass; flagged, not silently
ignored).

`.ai/` vs source tree: no new contradiction found beyond what's already
tracked in `.ai/KNOWN_ISSUES.md`.

## 3. Dependency and Lockfile Integrity — P0

**Confirmed, real, new finding.** `package.json` declares
`livekit-client: ^2.7.0`; `package-lock.json` (lockfileVersion 3)
contains **zero** references to `livekit-client` or any of its
transitive dependencies anywhere in the file — verified by direct grep,
not inferred. Corroborating behavioral evidence: this sandbox's `npm ci`
run makes its very first network request specifically for
`livekit-client` (before anything else), which is the actual signature
of a package npm cannot resolve from the lock file at all, not merely a
registry-access failure pattern that would look the same regardless of
which package happened to be requested first.

**Not hand-fixed.** Per this phase's own instruction, lockfile entries
were not fabricated by hand — doing so would produce a file that looks
resolved but wasn't actually computed by npm's real dependency
resolution, integrity-hash generation, and transitive-tree walk, which
is worse than the current honestly-broken state.

**Required fix**, to be run in an environment with real npm registry
access: `npm install` (regenerates the full lock file) or, more
narrowly, `npm install livekit-client@^2.7.0` (updates just that
subtree). Either should be followed by a real `npm ci` to confirm
`package.json`/`package-lock.json` are now in sync. This is a
repository-state bug, not purely an environment limitation — it would
block `npm ci` in ANY environment, including a real CI pipeline with
full network access, until fixed at the source.

Other dependency checks (missing deps, unused critical deps, peer
conflicts, duplicate security-sensitive package versions, deprecated
packages, Capacitor dependency relationships): NOT RUN — would require
an installed `node_modules` tree or at minimum a working dependency
resolution to check meaningfully, both blocked by the above.

STATUS: BLOCKED BY ENVIRONMENT for the fix itself; the *finding* is
CONFIRMED (P0), not blocked.

## 4. Actual Build Verification

```
npm ci            -> FAIL: E403 Forbidden (registry.npmjs.org, this
                     sandbox has no network egress) AND would separately
                     fail on the lockfile mismatch above even with
                     network access.
npm run lint      -> NOT RUN (depends on npm ci)
npx tsc --noEmit  -> NOT RUN (depends on npm ci)
npm test          -> NOT RUN (depends on npm ci)
npm run build     -> NOT RUN (depends on npm ci)
npm run verify:lock / npm run check:rls -> NOT RUN (same reason; script
                     existence in package.json also not confirmed this
                     pass)
```

No code was modified in an attempt to make any theoretical test pass —
none could be run to test against.

## 5. Test Coverage and Test Quality

The four suites from the Phase 1 pass (`outputValidator.test.ts`,
`redact.test.ts`, `privacyGate.test.ts`, `secureStorageCrypto.test.ts`)
were reviewed again this pass, not rewritten — they remain honestly
scoped (see each file's own header comments) and still unexecuted
(BLOCKED, §4).

Explicitly still lacking coverage, as the brief asked to check: consent
lifecycle (Supabase read/write path itself, not just the pure
decision-logic already tested), `secureStorage.ts`'s IndexedDB
persistence integration (jsdom doesn't implement IndexedDB — see
`.ai/TEST_STATUS.md`), AI insight lifecycle/RLS, consent RLS, partner
unlink behavior, call history transitions, Realtime authorization,
upload finalization, push-token authorization — none of these have a
deterministic unit test in this repository as of this pass. No new
tests were added this pass: every one of these needs either a live
Postgres instance (RLS/trigger behavior can't be meaningfully unit-tested
against a mock — the entire point is real Postgres policy evaluation) or
was judged lower-value to fake-mock than to honestly flag as untested.
Adding a shallow mock-based test that doesn't exercise real RLS would
create false confidence, which this project's own standing rule
explicitly warns against.

## 6. Supabase Security Verification — P0 focus

Not re-derived from scratch this pass — `docs/PHASE_4_SECURITY_AUDIT.md`
already contains a real, dated, cumulative answer to the exact
questions this section asks (who can SELECT/INSERT/UPDATE/DELETE, can a
user modify partner-owned data, can an ex-partner retain access, can UUID
knowledge bypass authorization, can client-side fields be spoofed, is a
trigger backing RLS where needed, is authorization based on current
relationship state) for: `user_consents`/`ai_insights` (§ Phase 1
migration, this file's own triggers), `partner_requests` (§15 — sender_id
immutable, transition-guarded), `call_history` (§ call-status spoofing
fix, prior passes), push/device tables (§20 — clean, no client
write-grant at all), `invite_links` (fixed — crypto-random codes),
storage policies (§16, `finalize-upload` bucket fix), Realtime
authorization (§18), `search_users` (§ enumeration guard, prior pass),
`send-push` (§19 — recipient authorization fix). Reading that document
in full is the actual answer to this section; restating it here would
duplicate it without adding verification depth, since nothing new was
tested against a live database this pass.

Actual Postgres/RLS attack tests (the negative-case list: user A
reading user B's insight, an ex-partner reading old data, ID spoofing,
status spoofing, cross-user consent writes, cross-couple Realtime
access, uploading as another user, arbitrary-recipient push): **NOT
RUN**. No live Supabase project in this environment. Every fix described
above was verified by hand against the actual policy/trigger SQL and the
actual client call sites, not by executing an attack against a running
database. This distinction is maintained deliberately, not glossed over.

## 7. Realtime Authorization

Migration (`20260916150000_realtime_authorization_couple_channels.sql`)
gates `typing`/`presence`/`groic`/`blend-sync` topics on the caller being
one of the two UUIDs in the topic AND that other UUID being their
**current** `partner_id` — not just UUID knowledge, and not a stale
former pairing (closes the ex-partner-still-knows-the-UUID scenario
specifically). Both properties were true as of the migration's own
design and re-confirmed by reading the trigger function again this pass.

**Dashboard setting: NOT VERIFIED — MANUAL DASHBOARD CHECK REQUIRED.**
Per Supabase's own documentation, enforcing private channels also
requires disabling "Allow public access" under Project Settings →
Realtime → Settings — a project-level toggle no migration or this
environment can set or check. The migration existing is not evidence
this toggle is off. Tracked explicitly as `.ai/KNOWN_ISSUES.md` KI-09.

## 8. Calling Architecture Verification

Not re-audited line-by-line this pass (would substantially duplicate the
existing, real audit trail in `docs/NATIVE_CALL_AUDIT.md`,
`docs/CALL_CONNECTION_AUDIT_V2_REPORT.md`, and
`docs/calling-architecture-v2.md` where present in this snapshot). Both
paths (Daily default, LiveKit opt-in scaffold) remain in the state those
documents describe: Daily is the production default; LiveKit is wired
end-to-end by static analysis, never runtime-verified.

**Architectural rule reaffirmed, not newly implemented**: push
notification remains the wake mechanism for a killed/backgrounded app;
no persistent WebSocket is used for that purpose anywhere in this
codebase (confirmed by the existing native call-handling code's own
structure — FCM/APNs → native call UI, not a WebSocket listener kept
alive in the background). Whether "deferred WebSocket post-wake
accept/cancel coordination" is implemented beyond what already exists
was NOT independently re-verified this pass — no new code was written
for it, since doing so without live device/signaling-server access would
be exactly the kind of "build it blind, can't test it" work this
project's own standing practice avoids. Flagged for a session with real
LiveKit/device access rather than attempted here.

## 9. Calling Latency Investigation

**Not measured this pass — cannot be, honestly.** Tracing T0–T11 requires
a running app, a live signaling/Daily connection, and real network
conditions; none exist in this sandbox. `src/lib/callLatency.ts` (a
trace-ID helper, noted in an earlier pass) was not re-inspected this
pass to determine whether it's actually wired into each of the ten
stages the brief lists — that determination, and the actual
instrumentation work if it's missing, is real work for a session with a
live app to run it against. No latency numbers, causes, or
"probably the bottleneck is X" guesses are offered here, per this
project's own standing rule against optimizing on intuition alone.

## 10. Chat Reliability

Not re-audited line-by-line this pass. No new bug was found or fixed in
`useChatRealtimeMessages`/`Chat.tsx`/`pendingSendQueue` this pass; no
live-reconnect/retry-storm testing was performed (would need a real
Supabase Realtime connection and an actual network-interruption
scenario, neither available here). This section is explicitly NOT
VERIFIED this pass rather than silently assumed fine.

## 11. Privacy / Consent Foundation

Re-read `dataClassification.ts`, `consent.ts`, `privacyGate.ts`,
`redact.ts`, `secureStorage.ts`, `outputValidator.ts`,
`localProcessor.ts`, `PrivacyAISettings.tsx`, and the `ai_insights`
migration in full this pass. The pipeline (classification → capability
→ absolute-deny-rules → consent → destination → processing → validation
→ storage/sharing) is present and, on static reading, internally
consistent with itself — `canProcess()`'s actual check order matches
this description (deny rules first, then capability, then consent, then
a second destination sanity check). Fail-closed behavior confirmed by
reading each function: `hasConsent()` returns `false` on any read error;
`canProcess()` returns `{ allowed: false }` on a missing userId without
even attempting the consent check.

**Existing mood/face features checked against this architecture, as
required — genuinely not previously done, done for real this pass**:
`MoodDetector.tsx`, `useBackgroundMoodDetection.ts`, `MoodHistory.tsx`,
`LipReadingOverlay.tsx`, `useLipReading.ts`, `PeekGuard.tsx` were located
and their consent/data-flow reasoned through against
`ConsentFeature`/`DataClassification`. Finding: **none of them call
`privacyGate.ts` or `consent.ts` at all** — they predate this phase's
consent system entirely and run unconditionally (gated only by their own
older, feature-specific toggles, e.g. Peek Guard's own on/off setting).
This is not itself a newly-introduced bug — these features existed and
worked the same way before Phase 1 — but it does mean the new consent
system's `CAMERA_ANALYSIS`/`MICROPHONE_ANALYSIS` toggles in
`PrivacyAISettings.tsx` are currently **decorative** with respect to
these specific existing features: turning `CAMERA_ANALYSIS` off in the
new settings screen does not currently stop Peek Guard or
LipReadingOverlay from using the camera, because neither checks it. This
is a real integration gap, not fixed this pass (retrofitting four
existing, already-shipped, working features to route through a new
consent gate is a meaningful behavior change to code this phase's own
"do not remove existing functionality" instruction argues for extreme
care around, not a drive-by edit) — tracked explicitly as a new item
below rather than left implicit.

## 12. Secure Storage

Re-confirmed accurate as previously documented: software AES-256-GCM
(Web Crypto API), key in IndexedDB, values through `prefs.ts` — **not**
Android Keystore/iOS Keychain hardware-backed, and not described as such
anywhere in code or docs (checked this pass specifically for any
overclaiming language — found none).

- Key generation: `crypto.subtle.generateKey`, once per (user, device).
- Key persistence: IndexedDB, unsynced, never leaves the device.
- Key rotation: not implemented (§ same as Phase 1's own report).
- Logout wiping: implemented (`secureWipeAll`, wired into
  `signOutAndClearPushTokens` in the Phase 1 pass).
- Tamper detection: implicit via AES-GCM's own authentication tag — a
  tampered ciphertext fails to decrypt (verified by the existing
  `secureStorageCrypto.test.ts` test, though unexecuted — §5).
- Recovery behavior: none by design — a lost device's secureStorage data
  is not recoverable, which is the intended behavior for this class of
  data.
- IndexedDB failure behavior: `secureGet`/`secureSet` catch and log
  rather than throw on decrypt failure, per the existing code; a genuine
  IndexedDB-unavailable environment (e.g. some private-browsing modes)
  was not tested this pass — `idbGet`/`idbSet` in `keystore.ts` already
  swallow such failures per its own existing design (confirmed by
  reading it again, not new this pass).
- Reinstall behavior: not tested — would depend on whether IndexedDB
  survives an app reinstall on the target platform, which needs a real
  device.

Native Keystore/Keychain integration remains explicitly tracked as
future native-production work (`.ai/KNOWN_ISSUES.md` KI-02), not
papered over with a fake abstraction — reaffirmed, not newly decided,
this pass.

## 13. Consent Export / Data Lifecycle

Not implemented this pass. Minimum safe scope, as determined by reading
the existing RLS: viewing consent state and revoking it are already
possible via `PrivacyAISettings.tsx` (existing, from Phase 1); deleting
an AI insight is already possible via the existing owner-DELETE RLS
policy on `ai_insights`, just with no UI for it yet (nothing to delete —
no insights exist). A genuine export flow (consent records + insights as
a downloadable JSON, say) was judged out of scope for a
production-*verification* pass specifically — it's a feature addition,
not a verification task, and the brief's own instruction ("implement
only if it can be done consistently with the existing privacy
architecture") reads as permissive, not mandatory. Left for Phase 2 or a
dedicated pass; tracked in `.ai/KNOWN_ISSUES.md` KI-05 (already existed
from Phase 1, unchanged).

## 14. Edge Function Audit

Already performed as a complete function-by-function matrix in
`docs/PHASE_4_SECURITY_AUDIT.md` §19 (all ~22 functions, including every
category this section calls out by name: call creation, token issuance,
push notifications, uploads, relationship-state modification). Not
re-run from scratch this pass — re-reading that matrix in full is the
actual answer; it was written to this exact standard (auth,
authorization, input validation, ownership, partner verification,
service-role usage, secrets, error leakage, rate limiting) already. One
new, narrower addition this pass: `livekit-token`'s handling was
re-confirmed to still match §19's original description (careful,
self-aware, scoped correctly) — no change found.

## 15. TypeScript Safety Audit

See `.ai/KNOWN_ISSUES.md` KI-08 for the full writeup. Summary: 183
occurrences (36 `: any`, 147 `as any`) sampled, not exhaustively
individually classified — the large majority trace to one documented
systemic cause (broken generated Supabase types) and were judged
JUSTIFIED as a class, since RLS/triggers remain the actual runtime
authorization boundary regardless of client-side typing looseness. Zero
`@ts-ignore`/`@ts-expect-error` anywhere in `src/` (checked exhaustively
— this one was a full count, not a sample, since it's cheap to check
completely). Zero non-null assertions found in the specific
security-sensitive directories checked (`src/lib/privacy/`,
`src/lib/ai/`, `src/lib/crypto.ts`, `src/integrations/supabase/`) — not
exhaustively checked project-wide. One RISK-adjacent observation, not a
BUG: `MinimizedCallBubble.tsx` accepts client-supplied
`duration_seconds`/`ended_at` for its own already-in-progress call (low
severity, self-scoped, not fixed — KI-08). Three redundant `as any`
casts in `consent.ts` removed as a trivial real fix this pass.

## 16. Performance Audit

Not run this pass — would need a live running app (React DevTools
profiler, actual Supabase subscription counts at runtime, actual memory
profiling) to do honestly rather than guess from source. No speculative
micro-optimizations made, per the brief's own instruction.

## 17. Production Readiness Matrix

**A. FIXED (this pass)**
- 3 redundant `as any` casts removed in `src/lib/privacy/consent.ts`.
- 6 governance `.ai/` files restored (`PROJECT_CONTEXT.md`,
  `DO_NOT_CHANGE.md`, `IMPLEMENTATION_RULES.md`, `NATIVE_PROJECTS.md`,
  `DO_NOT_BUILD.md`, `FUTURE_ROADMAP.md`).

**B. VERIFIED (hand-verified against source, not executed)**
- Realtime channel topic-authorization logic ties to current
  `partner_id`, not bare UUID knowledge (§7).
- Privacy-gate pipeline order and fail-closed behavior (§11).
- Secure-storage's honest non-hardware-backed status, accurately
  documented everywhere checked (§12).

**C. BLOCKED BY ENVIRONMENT**
- `npm ci`/lint/`tsc`/test/build (§4).
- Every live-DB RLS/trigger attack test (§6).
- Realtime "Allow public access" dashboard check (§7) — NOT VERIFIED,
  manual check required, distinct from a pure environment block.
- Calling latency instrumentation/measurement (§9).
- Device testing, Android/iOS build verification (no SDK/Xcode/device
  in this or any prior sandbox).

**D. NOT VERIFIED**
- Chat reliability under real reconnect/retry conditions (§10).
- Consent-lifecycle/AI-insight-RLS/partner-unlink/upload-finalization/
  push-token-authorization *live* tests specifically (§5/§6) — the
  *code* for all of these was hand-verified in earlier passes; the
  *live behavior* has never been executed.
- Whether the deferred WebSocket post-wake coordination work is complete
  (§8).

**E. REMAINING P0**
- `package.json`/`package-lock.json` out of sync for `livekit-client`
  (§3, KI-07) — blocks `npm ci` in any environment until fixed at the
  source, not just this sandbox.
- The standing, project-wide item: nothing has ever been
  build/lint/test/device-verified in any sandbox this project has run
  in (KI-06, unchanged, not new to this pass).

**F. REMAINING P1**
- None newly identified this pass beyond what §6/§14 already reference
  from `docs/PHASE_4_SECURITY_AUDIT.md`'s own still-open items
  (encryption lifecycle threat model, session/clock-skew handling, a
  telemetry review broader than Phase 1's client-side redaction, the
  docs-vs-source discrepancy matrix).

**G. REMAINING P2/P3**
- Existing mood/face features not routed through the new privacy/consent
  gate (§11, new finding this pass — real integration gap, not fixed).
- `.ai/` file loss recurring pattern (KI-01, partially mitigated).
- Secure storage not hardware-backed (KI-02).
- `secureStorage.ts` IndexedDB path untested (KI-03).
- No consent/insight export path (KI-05).
- TypeScript `any` systemic pattern + the one call-duration observation
  (KI-08).

## 18. Strict Feature Freeze

Confirmed unchanged: no relationship-AI feature (compatibility,
mood-inference-as-fact, deception/cheating detection, personality
inference, relationship diagnosis, predictive breakup scoring,
surveillance, hidden monitoring, DuoAutoAnswer) exists anywhere in this
codebase as of this pass. Nothing in this pass's own work implements any
of them.

## 19. Do Not Change

No UI redesign, no navigation change, no visual-language change, no
removal of existing functionality. The only UI-adjacent change referenced
anywhere in this report (§11's finding) was NOT acted on — it's flagged
as a gap for a future, deliberate pass, not silently fixed with a
drive-by UI edit this pass.

## 20. Final Gate

1. Does `npm ci` work? **NO** — E403 (network) in this sandbox, AND
   would independently fail on the `livekit-client` lockfile mismatch
   even with network access (§3).
2. Does TypeScript compile? **NOT VERIFIED** — depends on #1.
3. Does lint pass? **NOT VERIFIED** — depends on #1.
4. Do tests pass? **NOT VERIFIED** — depends on #1; 4 suites exist,
   unexecuted.
5. Does production build pass? **NOT VERIFIED** — depends on #1.
6. Are Supabase migrations verified? **NOT VERIFIED (live)** — every
   migration hand-verified against its own SQL and known call sites; none
   executed against a real Postgres instance.
7. Are RLS attack scenarios verified? **NOT VERIFIED** — no live DB
   (§6).
8. Is Realtime authorization verified? **PARTIALLY** — the code/migration
   is real and hand-verified; the required dashboard toggle is NOT
   VERIFIED — MANUAL DASHBOARD CHECK REQUIRED (§7, KI-09).
9. Are upload policies verified? **NOT VERIFIED (live)** — code fixed
   and hand-verified in an earlier pass (finalize-upload bucket
   allowlist); never executed against live Storage.
10. Are push authorization paths verified? **NOT VERIFIED (live)** —
    `send-push` fix hand-verified against source; `send-voip-push`
    confirmed already-correct by the same method; neither executed live.
11. Is Chat verified under reconnect/retry conditions? **NO** — not
    attempted this or any pass (§10).
12. Are calls verified on two real devices? **NO** — no devices in any
    sandbox this project has used.
13. Is call latency measured rather than guessed? **NO** — explicitly
    not guessed either; simply not measured (§9).
14. Is Daily verified? **NOT VERIFIED (live)** — architecture reviewed,
    never run against a live Daily room.
15. Is LiveKit verified? **NOT VERIFIED (live)** — wired by static
    analysis only, per every prior pass that's touched it; also blocked
    by the §3 dependency issue from even installing correctly.
16. Are Android native paths verified? **NO** — no Android SDK in any
    sandbox.
17. Are iOS native paths verified? **NO** — no Xcode/macOS in any
    sandbox.
18. Is privacy/consent actually enforced? **PARTIALLY** — enforced for
    the new Phase 1 foundation itself (hand-verified, DB-layer-backed);
    NOT enforced for four pre-existing features that predate it
    (MoodDetector, useBackgroundMoodDetection, LipReadingOverlay/
    useLipReading, PeekGuard) — new finding this pass, §11.
19. Is secure storage's real security level documented? **YES** —
    accurately, as software AES-256-GCM, explicitly not hardware-backed,
    consistently across code comments and `.ai/SECURITY_MODEL.md`.
20. Are all remaining P0/P1 issues explicitly listed? **YES** — §17
    above, and `.ai/KNOWN_ISSUES.md` in full.

### External verification procedure required (for every BLOCKED/NOT VERIFIED item above)

1. An environment with real npm registry access: run `npm install`,
   commit the regenerated lockfile, then `npm ci` → lint → `tsc --noEmit`
   → `npm test` → `npm run build`, in that order, stopping and reporting
   the exact failure at whichever step first fails.
2. A real (or disposable staging) Supabase project: apply every
   migration in order, then run the negative-case attack scenarios
   listed in §6 above and in `docs/PHASE_4_SECURITY_AUDIT.md` §13,
   with two real test accounts (A, B) and a real couple pairing.
3. Supabase dashboard access: confirm "Allow public access" is disabled
   under Realtime Settings (KI-09).
4. Two physical devices (one Android, one iOS ideally) or at minimum one
   of each platform's emulator/simulator with real push credentials
   configured: full incoming/outgoing call lifecycle on both Daily and
   (if pursuing that track) LiveKit, with `src/lib/callLatency.ts`'s
   trace IDs actually instrumented end-to-end per §9's T0–T11 list.
5. Real device testing for secure storage: logout, app-kill/restart,
   reinstall, and (if feasible) a private-browsing/IndexedDB-restricted
   mode, per §12.

## Final Status

**NOT READY**

DuoSpace is not ready for external verification and not production
verified. It is closer than before this pass in two concrete ways (a
real, previously-undiscovered P0 dependency bug is now found and
documented with its exact fix; a real privacy-integration gap in
pre-existing mood/face features is now found and documented) — but nothing
this pass did changes the fundamental blocker every pass has reported
honestly: this project has never been executed — not compiled, not
linted, not tested, not run against a live database, not run on a real
device — in any environment it has been worked in. That is the single
fact that has to change before any status better than NOT READY is
defensible.

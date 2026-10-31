Formal security model — consolidates findings from
`docs/PHASE_4_SECURITY_AUDIT.md` (the ongoing adversarial audit) with
this phase's new Key Management section. This file is the "what's the
current security posture" summary; the audit doc is the detailed,
dated log of individual findings.

## Trust boundaries (existing, pre-Phase-1)

Authentication: Supabase Auth (email/password, OAuth, WebAuthn/passkeys —
audited, see `docs/PHASE_4_SECURITY_AUDIT.md` §19, no findings).
Authorization: RLS on every table, enforced at the database layer, not
just client-side filtering (per this repo's own standing rule).
Pairing: QR tokens (256-bit, hashed, short-TTL, audited clean) and
partner_requests (transition-guarded as of 2026-09-16). Calling: self-hosted
only — WebSocket signaling (ticket auth, one socket per user, partner +
session authorization on every message) and LiveKit media with tokens
minted by `livekit-token` (JWT identity, service-role call facts, mutual
partnership, claim, derived room, short TTL). Unverified on devices — see
`docs/calling-architecture.md`.

## Data classification tiers

See `.ai/DATA_CLASSIFICATION.md`.

## Key management (new this phase)

- **E2E message encryption**: ECDH P-256 + AES-GCM (`src/lib/crypto.ts`,
  pre-existing, not touched this phase). Private keys stored in IndexedDB
  (`src/lib/keystore.ts`).
- **Local encrypted storage for future sensitive local data**
  (`src/lib/privacy/secureStorage.ts`, new this phase): software
  AES-256-GCM (Web Crypto API), master key generated once and held in the
  same IndexedDB store the E2E keys already use, values written through
  the existing `prefs.ts` (native SharedPreferences/UserDefaults under
  the hood via Capacitor).
- **Honest limitation, stated plainly**: neither of the above is backed
  by Android Keystore or iOS Keychain hardware-protected storage. This is
  software-only encryption-at-rest, which is still a real improvement
  over plaintext (defeats casual disk access, a stolen backup file, or
  another app on a rooted/jailbroken device reading SharedPreferences
  directly) but does not protect against a compromised OS or someone with
  root/jailbreak access and time to extract IndexedDB. A genuinely
  hardware-backed implementation needs a native Capacitor plugin — real
  native development requiring an Android/iOS toolchain and a physical
  device to build and verify, neither available in this environment.
  Tracked in `.ai/KNOWN_ISSUES.md` rather than silently implied to be
  solved.
- **Key rotation**: not implemented. The master key is generated once per
  user per device and never rotated. Rotating it would require
  re-encrypting everything under it, which needs a real migration
  strategy this phase didn't design.
- **Key invalidation on logout**: `secureWipeAll(userId)` deletes the
  master key (making any remaining ciphertext permanently unrecoverable —
  correct behavior) and every value this module wrote; wired into
  `signOutAndClearPushTokens()` in `Settings.tsx` this phase, best-effort
  (never blocks sign-out itself). **Not** wired into account deletion —
  that flow wasn't located/touched this phase; see Known Issues.
- **Device loss**: no recovery path for `secureStorage`-encrypted local
  data exists or is intended to (it's meant for exactly the kind of data
  that shouldn't survive a lost device) — the cloud backup system
  (`useCloudBackup.ts`, pre-existing) is separate and already
  user-key-encrypted before upload, unaffected by this phase.

## New tables' RLS (this phase)

`user_consents`: owner-only SELECT/INSERT/UPDATE, no DELETE policy
(consent is an audit trail, not erasable history). `ai_insights`:
owner SELECT/INSERT/UPDATE/DELETE, plus SELECT for a partner the insight
was explicitly `SHARED` with. Two triggers back these RLS policies at the
database layer (not just app logic): `enforce_ai_insight_consent`
(insert-time — the `consent_reference` must be real, owned by the same
user, and currently granted) and `enforce_ai_insight_immutability`
(update-time — only lifecycle/expiry/correction/sharing fields may ever
change post-creation). See the migration's own comments for the full
reasoning.

## Not verified this phase

Live database behavior (RLS, triggers, cross-account isolation) — no
Supabase access in this environment, same as every prior pass. See
`.ai/TEST_STATUS.md`.

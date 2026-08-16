# DuoSpace — Architecture (verified)

## Runtime shape

```text
React SPA (Vite)  ──►  Supabase Postgres (RLS)  ──►  Storage buckets
      │                      ▲
      │                      │ service_role
      └──► Supabase Edge Functions (Deno) ──► Daily.co / FCM / APNs / YouTube
      │
      └──► Capacitor native shell (Android / iOS)
```

## Edge functions (`supabase/functions/`)

| Function | Auth | Purpose |
| --- | --- | --- |
| `daily-call` | user JWT | Creates Daily room + meeting token. Resolves the Daily key server-side only (own key → partner key → optional platform key). |
| `finalize-upload` | user JWT | Reassembles chunked uploads. Ownership-checked, size-checked, and idempotent via an atomic claim on `pending_uploads`. |
| `cleanup-orphan-uploads` | service_role only | Cron cleanup of stale chunk files. |
| `complete-signup`, `set-email-password` | user JWT | Account completion flows. |
| `issue-qr-token`, `redeem-qr-token`, `qr-anon-issue` | mixed; `redeem-qr-token` and `qr-anon-issue` run with `verify_jwt = false` by design (they run before a session exists) | QR sign-in. |
| `webauthn-*` (4) | mixed | Passkey registration and login. |
| `send-push`, `send-voip-push`, `notify-signin`, `send-email`, `deliver-scheduled-messages` | service_role / user JWT | Notifications and scheduled delivery. |
| `music-search` | user JWT | YouTube/Piped search for Groic (client falls back to Piped directly if unreachable). |

`verify_jwt = false` functions must do their own authorisation. They are the
only unauthenticated surface in the backend and are the first place to look in
any security review.

## Native calling

Native call UX lives in two places and is **not** shared code:

- `native/android/*.kt` — Telecom/ConnectionService integration
  (`TelecomHelper`, `DuoSpaceConnectionService`, `CallRingingService`,
  `CallNotificationService`, `NotificationChannels`).
- `native-plugins/` — three local Capacitor plugins consumed as
  `file:` dependencies and aliased in `vite.config.ts` + `tsconfig.app.json`
  because they ship TS sources with no prebuilt `dist`:
  `audio-route`, `device-status`, `callkit-bridge`.

Any new local plugin must be added to **both** the Vite alias map and the
tsconfig paths, or the build fails to resolve it.

## Calling: single Daily instance invariant

Daily's SDK permits exactly one `DailyCall` object per page. `useDailyCall()`
is therefore instantiated once in `CallContext` and shared; never call the hook
directly from a page.

## DuoAutoAnswer (specification only — not implemented)

Intended behaviour: when the paired partner initiates a call and the callee has
explicitly opted in, the device answers automatically after a configurable
delay, surfacing a full-screen native call UI.

Preconditions before any implementation is attempted:
- Explicit, revocable per-device opt-in stored server-side, default **off**.
- Android: `ConnectionService` self-managed calls plus foreground-service
  microphone permission; iOS: CallKit + VoIP push (`send-voip-push` exists).
- An audible/visual indication that auto-answer occurred; no silent hot-mic.

No auto-answer code exists in the repository today.

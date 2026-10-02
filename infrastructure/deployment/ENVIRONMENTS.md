# Self-hosted calling — environments

Local, staging and production are **different things** and are selected
explicitly by env file. Nothing is inferred.

Media/SFU/TURN run on **LiveKit Cloud** — there is no LiveKit config file,
no `LIVEKIT_NODE_IP`, no TURN certificate, no coturn to manage per
environment anymore. Use a separate LiveKit Cloud project (or at minimum a
separate API key pair) per environment so credentials never cross
local/staging/production.

| | Local browser | LAN physical device | Staging | Production |
|---|---|---|---|---|
| Env file | `.env` (from `.env.example`) | `.env` with LAN values | `.env.staging` | `.env.production` |
| Signaling URL (`VITE_SIGNALING_URL`) | `wss://localhost:8787` | `wss://<LAN-IP>:8787` | `wss://signaling-staging.<domain>` | `wss://signaling.<domain>` |
| LiveKit Cloud project | dev project (or shared) | dev project (or shared) | dedicated staging project/key | dedicated production project/key |
| `SIGNALING_ALLOWED_ORIGINS` | empty (dev only) | empty (dev only) | allowlist — **required**: the server refuses to start with NODE_ENV=production and an empty list. Include `https://localhost` (Android) and `capacitor://localhost` (iOS); `*` = deliberate allow-any | allowlist (same rule) |

## Rules

- **`localhost` means "this machine".** On a phone it is the phone. A
  physical Android/iOS device must be given the dev machine's LAN IP for
  `VITE_SIGNALING_URL`. (LiveKit Cloud's URL is already a public `wss://`
  hostname — no LAN/localhost distinction applies to it.)
- **The WebView origin is `https://localhost`** (`capacitor.config.json`
  sets no `androidScheme`), so a plain `ws://` URL is blocked as mixed
  content. LAN-device testing of the *signaling gateway* therefore needs
  `wss://` with a certificate the device trusts (e.g. a `mkcert` CA
  installed on the device) — or test against staging. LiveKit Cloud is
  always `wss://` with a valid public certificate, so this only applies to
  the signaling gateway you host yourself.
- `SUPABASE_SERVICE_ROLE_KEY` exists only in the signaling container's
  environment. It must never appear behind a `VITE_` prefix or in a
  committed file.
- LiveKit Cloud API key/secret: never behind a `VITE_` prefix, never in
  this directory's `.env*` files — only as Supabase secrets (see
  `README.md` step 2).
- Run a **single** signaling-gateway instance: call state and rate limits
  are in memory.

## Deployment checklist (each item is *unverified* until you tick it)

1. Confirm migration `20260921065718_signaling_call_facts_and_session_id`
   is applied (it is, on the live project as of this migration).
2. Create/confirm the LiveKit Cloud project for this environment, then
   `supabase functions deploy livekit-token` and set `LIVEKIT_API_KEY`,
   `LIVEKIT_API_SECRET`, `LIVEKIT_URL` (matching this environment) as
   Supabase secrets.
3. Start the signaling gateway with the matching `--env-file`.
4. `GET http://<gateway>/healthz` → `{"ok":true,...}`.
5. Build the app with `VITE_SIGNALING_URL` for this environment.
6. Place a real call between two devices and confirm audio connects — see
   LiveKit Cloud's own dashboard for connection/TURN-relay diagnostics
   (Cloud manages and monitors its own TURN infrastructure; there is no
   self-hosted TURN checklist to run anymore).


## Signaling gateway is single-instance

Sessions (one socket per user), the call registry, ring timers, the
idempotency cache and rate limits live in one process's memory. Run exactly
ONE instance. Scaling out would split users across processes and silently
drop offers/accepts. Horizontal scaling needs shared session state or sticky
routing by user id first.

A user has ONE live signaling socket: opening the account on a second device
replaces the first (close code 4000). The replaced device no longer
auto-reconnects in a loop; it reconnects when the app is foregrounded, the
network changes, or a call action needs it.

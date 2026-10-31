# Calling: deployment checklist and device verification

Date: 2026-09-23.

## Root cause fixed in this revision
`signaling-ticket` signed tickets with `SUPABASE_JWT_SECRET`. Hosted Supabase **rejects any secret starting with `SUPABASE_`** (reserved prefix) and **does not inject the JWT secret** into Edge Functions (supabase.com/docs/guides/functions/secrets). The value was therefore always missing in production:
- every ticket request returned 503 `signaling_not_configured`;
- the app could never open its signaling socket;
- outgoing calls failed at "signaling not ready";
- incoming Accept waited for the socket until the accept watchdog failed it (stuck on "Connecting…").

The local end-to-end test did not catch this because the harness minted its own tickets.

**Fix:** a dedicated shared secret, `SIGNALING_TICKET_SECRET`, is used by both sides (the old name remains only as a local-dev fallback).

## Required configuration
| Where | Setting |
|---|---|
| Supabase → Edge Function secrets | `SIGNALING_TICKET_SECRET` = 32+ random bytes (`openssl rand -hex 32`), then **redeploy `signaling-ticket`** |
| Signaling server env | `SIGNALING_TICKET_SECRET` = **the same value** · `SUPABASE_URL` · `SUPABASE_SERVICE_ROLE_KEY` · `SIGNALING_ALLOWED_ORIGINS=https://localhost,capacitor://localhost` (Capacitor 8 defaults: Android `https://localhost`, iOS `capacitor://localhost`; add your web origin if used) |
| Supabase → Edge Function secrets | `LIVEKIT_URL` (`wss://<project>.livekit.cloud`), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, all from the **same** LiveKit project |
| APK build environment | `VITE_SIGNALING_URL=wss://<signaling-domain>` set **when running `npm run build`** (Vite inlines it at build time; the repo contains no `.env` with it) |

Validate with `npm run check:calling` against your production env file.

## Verifying a built APK really contains the signaling URL
```
unzip -p app-release.apk 'assets/public/assets/*.js' | grep -o 'wss://[a-zA-Z0-9.-]*' | sort -u
```
The output must show your signaling domain (not empty, not localhost).

## Where each stage is logged
- **App** (`chrome://inspect` → WebView console): `call.latency` lines with `callId`, `sessionId`, `stagesMs` and, on failure, `failureReason`. Stages include call_started, signaling_connect_started/connected, offer_sent/delivered, incoming_call, claim_started/completed, accept_sent/delivered, token_requested/ready, livekit_connect_started/connected, remote_participant_connected, remote_audio_track_received, remote_audio_ready, call_connected, call_failed, call_ended.
- **Signaling server** (stdout, JSON): `socket_connected`, `socket_closed`, `upgrade_rejected_origin {origin}`, `upgrade_rejected_auth {reason}`, `signal_accepted {type,status,state,call,session}`, `signal_rejected {type,reason}`. Ids are truncated; tokens and content are never logged.
- **livekit-token**: Supabase function logs (HTTP status + `code`).
- **LiveKit**: Cloud dashboard → room `duo-call-<callId>` → participant join/leave, tracks.

## Reading a failure
| First missing stage | Look at | Typical cause |
|---|---|---|
| signaling_connected | signaling logs: `upgrade_rejected_origin` / `upgrade_rejected_auth` | origin not allowlisted / secret mismatch / `signaling-ticket` 503 |
| offer_delivered | `signal_rejected` reason | NOT_PARTNERS, AUTHZ_UNAVAILABLE (service-role key) |
| token_ready | livekit-token logs | missing LIVEKIT_* secrets, not_claimed |
| livekit_connected | LiveKit dashboard | wrong URL/key project, network blocks |
| remote_audio_ready | LiveKit tracks | mic permission, audio routing |

## Verified here (real, local)
The real signaling server (configured with `SIGNALING_TICKET_SECRET` only), a real LiveKit 1.13.7 and two real WebRTC participants ran: ring → accept → tokens → same room → remote audio → end. A wrong-secret ticket was refused with 401.

**Physical devices, the deployed servers and TURN were NOT tested.**

## Instant Decline (2026-09-24)
```
supabase secrets set CALL_ACTION_SECRET=$(openssl rand -hex 32)
supabase functions deploy call-decline
supabase functions deploy send-push
npx cap sync android     # registers CallActionReceiver
```
Check: incoming call → Decline → phone stops ringing at once and the app does not open; the caller sees "declined". Supabase logs for call-decline show `decline_applied {declined:true}`.

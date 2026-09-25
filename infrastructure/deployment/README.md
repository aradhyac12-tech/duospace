# DuoSpace self-hosted calling infrastructure — local development

Media/SFU/TURN run on **LiveKit Cloud** (Build plan, free tier). This
directory now only deploys DuoSpace's own **signaling gateway** — the
authoritative call-control WebSocket server (offer/accept/reject/cancel/
end/ring-timeout). Nothing else in the calling architecture changed: same
Supabase migration, same `livekit-token` edge function, same call state
machine, same client reconnect logic, same UI.

## Prerequisites

- Docker + Docker Compose (for the signaling gateway only)
- A DuoSpace Supabase project (existing — this doesn't provision one)
- A LiveKit Cloud account + project — https://cloud.livekit.io (free
  "Build" plan is enough; no credit card requirement to start)
- Node 22+ if you want to run `infrastructure/signaling` outside Docker

## 1. Start the signaling gateway

```sh
cd infrastructure/deployment
cp .env.example .env
# Fill in SIGNALING_TICKET_SECRET, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
# SIGNALING_TICKET_SECRET must equal the Supabase Edge Function secret of the same name:
#   supabase secrets set SIGNALING_TICKET_SECRET=<same value>   (then redeploy signaling-ticket)
# (all three are REQUIRED — the gateway refuses to start without them; the
# service-role key is server-side only).
docker compose --env-file .env up
```

Local, staging and production are three separate env files
(`.env.example`, `.env.staging.example`, `.env.production.example`).

This starts `signaling` (ws://localhost:8787) — the Call Gateway. There is
no `livekit` or `coturn` service anymore.

**Apply the database migration first (already applied on the live
project as of this migration):**
`supabase/migrations/20260920140000_signaling_call_facts_and_session_id.sql`
(shipped as `20260921065718_signaling_call_facts_and_session_id` in the
live migration history) adds `call_history.session_id` and the
`signaling_get_call_facts` RPC the gateway calls. Self-hosted calls cannot
work without it.

## 2. Create a LiveKit Cloud project and set Supabase secrets

1. Sign up / log in at https://cloud.livekit.io and create a project on
   the free **Build** plan.
2. Project → Settings → Keys: create an API key/secret pair (or use the
   default one). Note the **Project URL** — it looks like
   `wss://your-project-xxxxxxx.livekit.cloud`.
3. Set these as Supabase secrets (never commit them, never put them in a
   `VITE_` variable, never put them in this directory's `.env*` files —
   the compose stack here never reads them):

```sh
supabase link --project-ref <your-project-ref>
supabase functions deploy livekit-token
supabase secrets set \
  LIVEKIT_API_KEY=<from LiveKit Cloud dashboard> \
  LIVEKIT_API_SECRET=<from LiveKit Cloud dashboard> \
  LIVEKIT_URL=wss://your-project-xxxxxxx.livekit.cloud
```

(`livekit-token`'s code is unchanged by this migration — it already reads
`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`/`LIVEKIT_URL` from `Deno.env` only,
so Cloud vs. self-hosted is purely a config swap, no redeploy of logic.)

## 3. Configure the frontend

Self-hosted signaling is the only calling provider — there is nothing to
switch on. Build the app with `VITE_SIGNALING_URL` set to the signaling
gateway's `wss://` URL (that part is unchanged — the gateway still needs
to run somewhere, e.g. a small VPS; LiveKit Cloud only replaces the
media/SFU/TURN layer, not call-control). Without it, calls refuse to
start with a clear "not set up on this build" error; there is no
fallback. Validate production config with `npm run check:calling` (see
`docs/calling-architecture.md`).

## 4. Test with two clients

Two logged-in DuoSpace sessions (two browser profiles, or one browser +
one device) pointed at the same Supabase project and built with the same
`VITE_SIGNALING_URL`. Automated coverage (unit/integration, not a live
two-peer connection): `src/test/signalingArchitecture.test.ts`,
`src/test/selfHostedCallEngineAdapter.test.ts`,
`src/test/livekitTokenAuthz.test.ts`, `infrastructure/signaling/test/`.

## What changed vs. the previous self-hosted-LiveKit deployment

- Removed: `livekit` and `coturn` services from `docker-compose.yml`,
  `infrastructure/livekit/*.yaml`, `infrastructure/coturn/turnserver.conf`,
  `LIVEKIT_CONFIG_FILE`/`LIVEKIT_NODE_IP`/`TURN_CERT_DIR` env vars, and all
  VPS firewall rules that existed only for LiveKit's own ports (7880,
  7881, 3478/udp, 5349, 50000-50100/udp) and for coturn.
- Removed: `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`/`LIVEKIT_URL`/
  `LIVEKIT_TOKEN_TTL_SECONDS` from this directory's `.env*` files — they
  were never read by anything except the edge function, so they now live
  only as Supabase secrets.
- Unchanged: `signaling` service, its env vars, the Supabase migration,
  the `livekit-token` edge function's code, the call state machine,
  authorization rules, client reconnect logic, and the UI.
- Still required: a host for the `signaling` service (VPS or equivalent)
  with TLS in front of it for `wss://` — LiveKit Cloud does not replace
  this piece, it only replaces the media/SFU/TURN layer.

## Known gaps (see docs/calling-architecture.md)

- No fallback provider, by design: a call whose signaling or LiveKit
  Cloud is unavailable fails clearly and cleans up.
- The gateway keeps ephemeral call state and rate limits in memory: run
  ONE instance (no horizontal scaling yet).
- The signaling server's unit tests pass (`infrastructure/signaling`, 70
  tests); nothing here has been runtime-verified against real devices.

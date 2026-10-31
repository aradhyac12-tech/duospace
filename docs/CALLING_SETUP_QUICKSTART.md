# Calling setup: quickstart (fixes "Self-hosted calling isn't set up on this build")

DuoSpace calls need **three** server pieces:

| Piece | What it does | Where |
|---|---|---|
| LiveKit (Cloud) | audio/video media | LiveKit Cloud project (already have) |
| Supabase Edge Functions | tickets, LiveKit tokens, push | your Supabase project |
| **DuoSpace signaling server** | ring / accept / decline / end (WebSocket) | **any Docker host with WebSockets** (Render, Railway, Fly.io, a VPS). **Not Vercel**: Vercel cannot hold WebSocket connections. |

That error means the app found **no signaling server URL**.

## 1) Deploy the signaling server (`infrastructure/signaling`, has a Dockerfile)
Example on Render: New → Web Service → this repo → Root Directory `infrastructure/signaling` → Docker. It listens on `$PORT`.

Environment variables on that service:
```
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service role key>      # Supabase → Settings → API
SIGNALING_TICKET_SECRET=<random 64 hex>           # openssl rand -hex 32 (same value as step 2)
SIGNALING_ALLOWED_ORIGINS=https://localhost,capacitor://localhost,https://<your-app>.vercel.app
```
Your public URL becomes e.g. `wss://duospace-signaling.onrender.com`.

## 2) Supabase secrets (never in the app, never in chat)
```
supabase secrets set SIGNALING_TICKET_SECRET=<same value as the server>
supabase secrets set SIGNALING_PUBLIC_URL=wss://<your signaling host>
supabase secrets set LIVEKIT_URL=wss://<project>.livekit.cloud
supabase secrets set LIVEKIT_API_KEY=<key>  LIVEKIT_API_SECRET=<secret>
supabase secrets set CALL_ACTION_SECRET=$(openssl rand -hex 32)    # instant Decline
supabase functions deploy signaling-ticket livekit-token send-push call-decline
```

## 3) No rebuild required
Builds **without** `VITE_SIGNALING_URL` now fetch the URL at runtime from `signaling-ticket` (`SIGNALING_PUBLIC_URL`) and cache it. Existing Vercel and APK builds start working after steps 1–2 plus a sign-in. `VITE_SIGNALING_URL` still works and wins if set at build time.

## 4) Check
- `https://<signaling host>/` should respond (a WebSocket upgrade without a ticket gets 401).
- App console: the `call.latency` line should show `signaling_connected`.
- Signaling server log: `socket_connected`, then `signal_accepted {type: CALL_OFFER …}`.

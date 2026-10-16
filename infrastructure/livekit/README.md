# infrastructure/livekit — REMOVED (migrated to LiveKit Cloud)

This directory used to hold `livekit.yaml` / `livekit.staging.yaml` /
`livekit.production.yaml` for a self-hosted LiveKit server. Media/SFU/TURN
now run on **LiveKit Cloud** (Build plan, free tier) — there is no
self-hosted LiveKit server or config file to maintain.

What replaced it: a LiveKit Cloud project's `wss://` URL + API key/secret,
set as Supabase secrets consumed by the `livekit-token` edge function. See
`infrastructure/deployment/README.md`.

Nothing else about the calling architecture changed — DuoSpace's own
WebSocket signaling gateway (`infrastructure/signaling`) still runs the
authoritative call-control state machine; only the media/TURN backend moved.

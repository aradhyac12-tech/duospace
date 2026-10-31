# Map → Home place + "reached home" alert (v3.22.37)

## What it does
- Map → house button (top right). Choose the spot by **searching an address** (OpenStreetMap), **"use my location"**, or **dragging the map under the centre pin**. Pick a **radius 50 m – 1 km** (slider + 100 m / 200 m / 500 m / 1 km chips); the circle is drawn live.
- Saved home shows as a house marker + dashed circle (tap the marker to edit).
- When your location enters the circle, the **database** pushes "<name> reached home" to your partner (tap opens the Map). Their Map pill shows "At home" while you are inside.

## How arrival is detected (server-side, works with the app closed)
`locations_home_arrival_trg` (AFTER INSERT/UPDATE on `locations`) compares each accepted fix with `home_places`.
- Arrival needs fix inside radius AND accuracy no worse than max(radius, 100 m).
- Leaving needs distance > radius × 1.25 + 30 m (hysteresis, no flapping).
- One alert per 20 minutes at most. Fixes older than 10 min are ignored.
- Saving / moving / resizing Home re-baselines silently (no alert if you save it while standing there).
- Respects Stop-sharing (those writes are dropped before the trigger).

## Privacy
Partner cannot read `home_places`. They get only label / inside / timestamps via `get_partner_home_status()`.

## Deploy
1. Apply `supabase/migrations/20261018120000_home_places_arrival_alerts.sql`.
2. Redeploy edge function `send-push` (`_shared/fcm.ts` now lets a `custom` push carry `route=/map`).
3. Rebuild the app (`usePushNotifications.ts`, MapView, new `components/map/HomePlacePanel.tsx`, `hooks/useHomePlace.ts`, `lib/geocode.ts`).
Requires the existing Vault secrets `project_url` / `service_role_key` (same as chat pushes).

## Test
1. Set Home on your phone with the pin on your current spot → no notification to partner (silent baseline).
2. Move Home 300 m away (or lower radius to 50 m and walk/drive away > 100 m), wait ~1 min.
3. Come back inside the circle → partner phone gets "<you> reached home"; partner's Map pill shows "At home".
Debug: `select * from home_places;` (is_inside, last_arrived_at, last_notified_at).

## Not verified here
No build/typecheck/DB run was possible in this environment (no node_modules, no Postgres). Syntax-checked only.

## v3.22.38 — "Left home" alert (optional, off by default)
- Home sheet shows "Also tell <partner> when I leave" once the arrival switch is on.
- Migration `20261018130000_home_leave_alert.sql` (apply AFTER the first one): adds `notify_leave`, `last_left_notified_at`, and replaces the two trigger functions. Leave needs distance > radius × 1.25 + 30 m, max one "left" alert per 20 min.
- Test: turn it on, walk/drive beyond the circle + margin → partner gets "<you> left home".

## v3.22.39 — "I'm heading home" (safe arrival)
- Pill above the bottom status chip: **I'm heading home** (needs a saved Home; you must be outside the circle). Partner gets "<you> is heading home", then sees distance + rough ETA (ETA appears after ~2 min of real progress) on their Map.
- One "hasn't moved in 10 minutes" push if there is no progress toward home (>30 m closer) while still > 2× radius away; re-arms on new progress.
- Arrival sends "reached home" even if the general Home alert switch is off (starting a trip is an explicit share). Trips auto-end on arrival, expire after 3 h, can be cancelled with ✕.
- Trip sharing needs Home's "tell my partner" switch ON (the card says "Not shared" otherwise).
- Migration `20261018140000_home_trips_safe_arrival.sql` (apply after the other two) — replaces `home_places_on_location()` again (arrival/leave rules unchanged).
- LIMITS: stall detection needs the phone to keep uploading (app keep-alive ~45 s); a phone that goes completely silent is not flagged (no scheduler). "Off the usual route" detection is not included.
- Test: set Home, go > radius away, tap the pill; partner phone: push + card. Stand still 10+ min away → stalled push. Return inside circle → arrival push, card clears.

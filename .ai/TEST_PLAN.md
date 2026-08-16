# DuoSpace — Live Test Plan

Automated tests cover only pure logic (`src/test/*`: rate limiting, network
state, telemetry, reconnect concurrency). Everything below requires a real
Supabase project and real devices, and must be run before a release.

## A. Supabase live checks (two accounts, A and B, paired)

1. **Secret isolation.** Signed in as A, run in the browser console:
   `await supabase.rpc('get_partner_daily_key', { _user_id: '<B user id>' })`
   → must fail with a permission error (not return a key). Repeat with A's own
   id → must also fail from the client.
2. **Row isolation.** As A, attempt to select B's `user_secrets`, messages, and
   gallery rows by id → zero rows every time.
3. **Storage isolation.** As A, attempt to upload to `<B user id>/...` → denied.
4. **Upload idempotency.** Fire `finalize-upload` twice concurrently for the
   same object → both return 200, one with `alreadyFinalized: true`, and the
   final file is byte-identical to the source.
5. **RLS gate.** `npm run check:rls` passes.

## B. Auth matrix

| Flow | Web | Android | iOS |
| --- | --- | --- | --- |
| Google OAuth | redirects to web callback, session persists across reload | returns to app via `duospace://auth`, session persists across cold start | same |
| Email + password | ✓ | ✓ | ✓ |
| Password reset | ✓ | deep link | deep link |
| QR sign-in | ✓ | ✓ | ✓ |
| Passkey | ✓ | ✓ | ✓ |
| Logout | session cleared, protected routes redirect | ✓ | ✓ |

No flow may ever land on `localhost` or a `null` origin.

## C. Calls (device-to-device, not simulator-to-simulator)

1. A starts a video call to B; B answers → two-way audio + video.
2. Same for audio-only.
3. Failure path: remove all Daily keys → clear 402 message, and the client-side
   cooldown is refunded (no bogus "wait 39 seconds").
4. Rate limit: three calls in a minute → third is rejected with 429, and a
   failed room creation does not consume a slot.
5. Navigate Chat ↔ Calls mid-call → the call survives (single shared
   `DailyCall` instance).

## D. Native

- Cold start with permissions denied → recovery sheet appears, app remains
  usable.
- Camera in use by another app → Peek Guard enrolment shows the busy-camera
  recovery path.
- Background/foreground during OAuth → session still completes.

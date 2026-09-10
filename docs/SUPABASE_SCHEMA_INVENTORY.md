# Supabase Schema Inventory

Built from a complete read of `supabase/migrations/*.sql` (36 database
functions, 33 RLS-governed tables, 9 realtime-enabled tables, 18 Edge
Functions, 4 pg_cron jobs). Classification legend: **PRIVATE_USER** (only
the owner), **PRIVATE_COUPLE** (owner + partner), **SYSTEM** (app-internal,
no direct user access), **PUBLIC** (intentionally open), **SERVER_ONLY**
(service_role/SECURITY DEFINER only), **SECURITY_SENSITIVE** (auth/secrets
adjacent), **EPHEMERAL** (short-lived, gc'd).

| Table | Purpose | Owner col | Partner? | RLS | Realtime | Classification |
|---|---|---|---|---|---|---|
| `profiles` | User profile, mood, pairing state, public key | `user_id` | yes (`partner_id`) | ✅ | no | PRIVATE_COUPLE |
| `messages` | Chat messages | `sender_id`/`receiver_id` | yes | ✅ | ✅ | PRIVATE_COUPLE |
| `message_reactions` | Emoji reactions on messages | `user_id` | via message | ✅ | ✅ | PRIVATE_COUPLE |
| `scheduled_messages` | Future-dated message sends | `sender_id` | no (owner-only until delivery) | ✅ | no | PRIVATE_USER |
| `partner_requests` | Pairing invitations | `sender_id`/`receiver_id` | n/a (pre-pairing) | ✅ | ✅ | PRIVATE_USER |
| `invite_links` | Code-based pairing invites | `creator_id` | n/a | ✅ | no | PRIVATE_USER + narrow public lookup |
| `qr_pairing_tokens` | QR-code device pairing | `user_id` | n/a | ✅ (deny-all direct) | no | SERVER_ONLY |
| `countdowns` | Shared countdown events | `creator_id` | yes | ✅ | no | PRIVATE_COUPLE |
| `memories` | Shared photo/caption memories | `creator_id` | yes | ✅ | no | PRIVATE_COUPLE |
| `taps` | "Thinking of you" nudges | `sender_id`/`receiver_id` | yes | ✅ | ✅ | PRIVATE_COUPLE |
| `daily_answers` | Daily relationship Q&A | `user_id` | yes | ✅ | no | PRIVATE_COUPLE |
| `playlist_songs` | Shared music playlist | `added_by` | yes | ✅ | no | PRIVATE_COUPLE |
| `shayaris` | Shared poetry/notes | `user_id` | yes | ✅ | ✅ | PRIVATE_COUPLE |
| `code_surprises` | Custom HTML/CSS/JS surprise pages | `creator_id` | yes | ✅ | no | PRIVATE_COUPLE |
| `code_surprise_events` | View/interaction events for a surprise | `user_id` | via surprise | ✅ | no | PRIVATE_COUPLE |
| `blend_invites` | Music-taste "blend" invites | `sender_id` | yes | ✅ | ✅ | PRIVATE_COUPLE |
| `locations` | Live location sharing | `user_id` | yes | ✅ | ✅ (table) | PRIVATE_COUPLE |
| `mood_logs` | Detected mood history | `user_id` | yes (read only) | ✅ | no | PRIVATE_COUPLE |
| `menstrual_cycles` | Cycle tracking | `user_id` | yes (read only) | ✅ | no | PRIVATE_COUPLE |
| `gallery_items` | Shared photo/video gallery metadata | `owner_id` | yes (if shared) | ✅ | no | PRIVATE_COUPLE |
| `imported_chats` | Imported chat history from other apps | `owner_id` | yes | ✅ | no | PRIVATE_COUPLE |
| `call_history` | Voice/video call records | `caller_id`/`receiver_id` | yes | ✅ | ✅ | PRIVATE_COUPLE |
| `pending_uploads` | Resumable-upload tracking rows | `user_id` | no | ✅ | no | PRIVATE_USER |
| `backup_runs` | Backup metadata (not the encrypted blob itself) | `user_id` | no | ✅ | no | PRIVATE_USER |
| `notification_history` | Delivered-notification log | `recipient_id` | no | ✅ | ✅ | PRIVATE_USER |
| `notification_preferences` | Per-user notification toggles | `user_id` (PK) | no | ✅ | no | PRIVATE_USER |
| `push_tokens` | FCM/APNs/VoIP device tokens | `user_id` | no | ✅ | no | SECURITY_SENSITIVE |
| `known_devices` | Recognized-device list | `user_id` | no | ✅ | no | PRIVATE_USER |
| `blocked_users` | User block list | `user_id` | no | ✅ | no | PRIVATE_USER |
| `webauthn_credentials` | Passkey public keys | `user_id` | no | ✅ | no | SECURITY_SENSITIVE |
| `webauthn_challenges` | In-flight passkey challenges | `user_id` | no | ✅ deny-all direct | no | EPHEMERAL / SERVER_ONLY |
| `email_change_otps` | Email-change OTP codes | (server-managed) | no | ✅ deny-all direct | no | EPHEMERAL / SERVER_ONLY |
| `rate_limits` | Server-side rate-limit counters | `user_id` | no | ✅ deny-all direct | no | SYSTEM / SERVER_ONLY |
| `user_secrets` | Per-user server-side secrets | `user_id` | no | ✅ | no | SECURITY_SENSITIVE |

`storage.objects` is governed separately — see `docs/SUPABASE_RLS_FINAL_MATRIX.md`.

## Storage buckets

| Bucket | Public? | Purpose |
|---|---|---|
| `chat-files` | private | Chat attachments |
| `gallery` | private | Gallery photos/videos |
| `avatars` | **public** (SELECT only; write/update/delete owner-scoped) | Profile pictures |
| `memories` | private | Memory photos |
| `backups` | private | Encrypted backup blobs |
| `attachments` | private | Generic attachments (owner-scoped ALL) |
| `surprise-assets` | **public** (SELECT only; write/delete owner-folder-scoped, fixed this session) | Code-surprise page assets, intentionally shareable with non-account recipients |

## Database functions (36 total)

Grouped by role:

- **Pairing/identity:** `accept_partner_request`, `accept_partner_request_v2` (thin wrapper), `accept_invite`, `unlink_partner`, `link_partners`, `complete_qr_pending_link`, `get_partner_id`, `get_partner_daily_key`, `search_users`, `get_user_id_by_email`
- **Chat/messages:** `guard_message_update` (trigger), `claim_pending_scheduled_messages`, `delete_expired_messages`, `cleanup_disappeared_messages`, `cleanup_accepted_requests` (trigger)
- **Calls:** `claim_call`, `cancel_call`, `decline_call`, `set_call_expiry` (trigger)
- **Push:** `private.dispatch_push`, `private.dispatch_voip_push`, `notify_push_on_call`, `notify_push_on_message`, `notify_push_on_partner_request`, `notify_push_on_reaction`, `notify_voip_on_call_claim`, `notify_voip_on_call_end`, `notify_voip_on_call_insert`, `sync_push_token_to_push_tokens`
- **Scheduled delivery (added this session):** `private.dispatch_scheduled_message_delivery`
- **Housekeeping/GC:** `qr_pairing_tokens_gc`, `webauthn_challenges_gc`, `email_change_otps_gc`, `update_updated_at_column` (trigger), `handle_new_user` (trigger)
- **Abuse protection:** `consume_rate_limit` (service_role only)

Every SECURITY DEFINER function reviewed this session sets a fixed
`search_path` (`public` or `public, extensions`) — no mutable-search-path
finding (Advisor item `0011`) was found. See
`docs/SUPABASE_RLS_FINAL_MATRIX.md` for the authorization review of each
client-invokable one.

**Dead-function finding (Section 22/Phase 8L territory — flagged, not
removed):** `cleanup_disappeared_messages()` and `delete_expired_messages()`
do the identical DELETE (`WHERE disappear_at IS NOT NULL AND disappear_at <
now()`). Only `delete_expired_messages()` is actually wired to a cron job;
`cleanup_disappeared_messages()`'s EXECUTE grant history shows it was once
callable by `authenticated`, then revoked, and is not called from any
source in `src/`, any Edge Function, or any cron job in this snapshot —
it's dead. Not dropped here per rule #14 (verify all references first) and
because a duplicate no-op function carries essentially zero risk — flagged
for a future cleanup pass rather than treated as urgent.

## pg_cron jobs (4 total)

| Job | Schedule | Purpose | Auth pattern |
|---|---|---|---|
| `delete-expired-messages` (`20260501205802`, "Section 7") | `* * * * *` | Disappearing-message cleanup — calls `delete_expired_messages()` | in-process (no HTTP call, no auth needed) |
| `cleanup-orphan-uploads` | `0 * * * *` | Remove orphaned upload chunks | pre-existing broken `app.settings.service_role_key` pattern (never fixed in this snapshot — see Section 6 finding below) |
| `deliver-scheduled-messages` (added this session) | `* * * * *` | Dispatch due scheduled messages | Vault-backed (`project_url`/`service_role_key`) |

Note: this snapshot's `cleanup-orphan-uploads` cron still uses
`current_setting('app.settings.service_role_key', true)`, which is never
`SET` anywhere in this repo and resolves to `NULL` — meaning that job's
Authorization header has likely always been `Bearer ` (empty), a
guaranteed 401. This was fixed in a different, later snapshot reviewed
earlier in this engagement but **has not yet been fixed in this specific
snapshot** — flagged here rather than silently left out, and worth a
follow-up migration using the same Vault pattern as
`deliver-scheduled-messages`.

## Edge Functions (18 total)

`_shared`, `cleanup-orphan-uploads`, `complete-signup`, `daily-call`,
`deliver-scheduled-messages`, `finalize-upload`, `issue-qr-token`,
`music-search`, `notify-signin`, `qr-anon-issue`, `redeem-qr-token`,
`send-email`, `send-push`, `send-voip-push`, `set-email-password`,
`webauthn-login-options`, `webauthn-login-verify`,
`webauthn-register-options`, `webauthn-register-verify`.

See `docs/SUPABASE_OBSERVABILITY.md` for per-function notes and
`docs/SUPABASE_PRODUCTION_CHECKLIST.md` for deployment verification status.

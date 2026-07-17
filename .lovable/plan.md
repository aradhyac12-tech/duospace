# Plan: Sign-in alerts, Google Drive via connector, default email sender

## 1. Email sender — use Lovable default (no branded domain)

Skip the email domain setup. Auth emails (signup confirm, password reset, magic link) will send from Lovable's default sender automatically — no branding, but works out of the box. This unblocks password reset and confirmation flows immediately.

Because there is no verified sender domain, we can't scaffold branded auth templates or the queue-based transactional pipeline. Sign-in device alerts will instead be sent through Resend using the shared `noreply@resend.dev` sender already wired in `send-email` (RESEND_API_KEY already configured).

## 2. Instagram-style new-device sign-in alerts

Send an email **only** when the user signs in from a device fingerprint we haven't seen before.

### Data

New table `known_devices`:

- `id uuid pk`
- `user_id uuid → auth.users`
- `fingerprint text` (SHA-256 of UA + platform + language + screen + timezone)
- `label text` (e.g. "Chrome on macOS")
- `last_seen_at timestamptz`
- `first_seen_at timestamptz`
- unique(user_id, fingerprint)
- RLS: users can read/delete their own rows; inserts go through the edge function (service role).
- GRANT SELECT, DELETE on authenticated; GRANT ALL on service_role.

### Edge function `notify-signin` (verify_jwt = true)

Input: `{ fingerprint, userAgent, platform, timezone }` from client.
Steps:

1. Auth the caller via JWT → get user + email.
2. Look up `known_devices(user_id, fingerprint)`.
3. If found → update `last_seen_at`, return `{ known: true }`. No email.
4. If not found → insert row, then call `send-email` internally (service-role invocation) with a formatted alert: device label, approximate location from Cloudflare `cf-ipcountry` / `x-forwarded-for` (best-effort, no external API), timestamp, and a "This wasn't me → secure account" link to `/settings#security`.
5. Rate-limit via existing `consume_rate_limit` (max 3 alerts / user / hour) to prevent spam if fingerprint churns.

### Client wiring

In `AppLayout` (or `useAuth`), on `SIGNED_IN` event only (not `TOKEN_REFRESHED` / `INITIAL_SESSION`):

- Compute fingerprint from `navigator.userAgent + platform + language + screen.width×height + Intl.DateTimeFormat().resolvedOptions().timeZone`, hash with SubtleCrypto SHA-256.
- Fire-and-forget `supabase.functions.invoke('notify-signin', { body: {...} })`.

Settings gets a "Recent devices" list reading from `known_devices` with a "Remove" button per row (deleting a row means next sign-in from that device triggers a new alert).

## 3. Google Drive backup via Lovable connector

Use the `google_drive` App connector (workspace-linked Google account, gateway-routed) instead of custom OAuth. This removes the need for `GOOGLE_DRIVE_CLIENT_ID`/`_SECRET`.

Caveat to flag to the user: the App connector authenticates **one Google account for the whole app** (the builder's), not per-end-user. If the user truly wants each end-user to pick their own Google account (WhatsApp-style), that requires the **App User Connector** flow, not the standard connector. I'll ask below.

### Steps (assuming App connector path is chosen)

1. Call `standard_connectors--list_app_connectors`, then `standard_connectors--connect` with `connector_id: "google_drive"` so the user picks/creates a Google connection.
2. New edge function `gdrive-backup` (verify_jwt = true):
  - Authenticates caller.
  - Reads user's backup payload (encrypted blob of messages/settings from client).
  - POSTs to `https://connector-gateway.lovable.dev/google_drive/upload/drive/v3/files?uploadType=multipart` with `Authorization: Bearer ${LOVABLE_API_KEY}` and `X-Connection-Api-Key: ${GOOGLE_DRIVE_API_KEY}`.
  - Stores file in `appDataFolder` with metadata `{ name: 'duospace-backup-<userId>-<ts>.json' }`.
  - Returns `{ fileId, size, createdAt }`.
3. New edge function `gdrive-list-backups`: GET `/drive/v3/files?spaces=appDataFolder&q=name contains 'duospace-backup'`.
4. New edge function `gdrive-restore`: GET `/drive/v3/files/{fileId}?alt=media`.
5. Update `BackupManager.tsx`:
  - "Back up now" → invoke `gdrive-backup`.
  - "Restore" → list + pick + restore.
  - Show connection status: "Connected to Google Drive (app account)".
  - Remove any leftover custom-OAuth UI.
6. Store `last_backup_at` and `last_backup_file_id` in `user_secrets` (columns already exist per prior migration or add if missing).

## Clarifying questions

1. **Google account picker scope** — for Drive backup, do you want:
  - (b) Each end-user picks/connects their own Google account (WhatsApp-style — requires the App User Connector flow, which needs a workspace-level OAuth client configured once)?
   Pick (b) if you want the true WhatsApp experience.
2. **Confirm default sender** — you're okay with sign-in alert emails coming from `noreply@resend.dev` (no branding) for now, and we'll revisit branded sender later when you set up a domain?

Once you answer, I'll switch to build and ship it.
-- Removes the Google Drive backup feature's storage, which is now dead:
-- the GoogleDriveBackup.tsx component and its four gdrive-* edge functions
-- (gdrive-connect-start, gdrive-connect-callback, gdrive-test-backup,
-- gdrive-disconnect) were deleted from the app because they were a
-- duplicate/dead UI superseded by BackupManager (Lovable Cloud Storage
-- backup) and were never reachable from any screen. Their OAuth handshake
-- was also broken on native (it hardcoded window.location.origin as the
-- redirect_uri, which resolves to https://localhost / capacitor://localhost
-- inside the app's WebView — not a URL the connector gateway could ever
-- redirect back to).
--
-- daily_api_key / daily_key_hint / daily_provides_calls / last_backup_*
-- columns on user_secrets are NOT touched here — those are still used by
-- DailyKeyManager and BackupManager respectively.

ALTER TABLE public.user_secrets
  DROP COLUMN IF EXISTS google_drive_refresh_token,
  DROP COLUMN IF EXISTS google_drive_email,
  DROP COLUMN IF EXISTS google_drive_connected_at,
  DROP COLUMN IF EXISTS last_backup_file_id;

DROP TABLE IF EXISTS public.backup_runs;

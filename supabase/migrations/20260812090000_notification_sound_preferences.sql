-- Adds per-user selectable notification sound + call ringtone to
-- notification_preferences. Ids must stay in sync with
-- supabase/functions/_shared/soundCatalog.ts and src/lib/notificationSounds.ts.
-- CHECK constraints (not a separate lookup table) mirror this table's
-- existing style of plain boolean/text columns for simple per-user settings.

ALTER TABLE public.notification_preferences
  ADD COLUMN IF NOT EXISTS message_sound text NOT NULL DEFAULT 'classic',
  ADD COLUMN IF NOT EXISTS call_ringtone text NOT NULL DEFAULT 'classic';

ALTER TABLE public.notification_preferences
  DROP CONSTRAINT IF EXISTS notification_preferences_message_sound_check,
  DROP CONSTRAINT IF EXISTS notification_preferences_call_ringtone_check;

ALTER TABLE public.notification_preferences
  ADD CONSTRAINT notification_preferences_message_sound_check
    CHECK (message_sound IN ('classic', 'chime', 'pop', 'marimba')),
  ADD CONSTRAINT notification_preferences_call_ringtone_check
    CHECK (call_ringtone IN ('classic', 'gentle', 'urgent', 'marimba'));

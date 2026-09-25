-- v3.11.1: more selectable message sounds + call ringtones.
--
-- The original CHECK constraints (20260812090000) listed the four ids that
-- existed then, so every new id would have been rejected on save. Rather than
-- re-listing ids here (and needing another migration for every future sound),
-- constrain the *shape* of the value. The real allow-list lives where it is
-- enforced: supabase/functions/_shared/soundCatalog.ts normalizes anything
-- unknown back to the default before a push is built, and the client only ever
-- offers ids from src/lib/notificationSounds.ts. src/test/
-- notificationSoundCatalog.test.ts keeps those two lists (plus the native
-- ones) identical.

ALTER TABLE public.notification_preferences
  DROP CONSTRAINT IF EXISTS notification_preferences_message_sound_check,
  DROP CONSTRAINT IF EXISTS notification_preferences_call_ringtone_check;

ALTER TABLE public.notification_preferences
  ADD CONSTRAINT notification_preferences_message_sound_check
    CHECK (message_sound ~ '^[a-z][a-z0-9_]{0,31}$'),
  ADD CONSTRAINT notification_preferences_call_ringtone_check
    CHECK (call_ringtone ~ '^[a-z][a-z0-9_]{0,31}$');

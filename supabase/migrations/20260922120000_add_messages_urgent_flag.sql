-- Additive only. /urgent is the strongest composer mode: it sets
-- important = true (so the existing send-push DND/mute bypass applies
-- unchanged) AND urgent = true, which the client uses purely to render the
-- message with a distinct "Urgent" treatment for both partners.
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS urgent boolean NOT NULL DEFAULT false;

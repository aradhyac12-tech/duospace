-- Surprise 3.0 §10: Sensory Director.
-- Nullable, no default value needed beyond NULL itself — NULL IS "Auto"
-- (every field left to the deterministic Haptic DNA), so every existing
-- surprise keeps behaving exactly as it does today the instant this ships.
-- A partial object (e.g. only `climax` set) is valid — unset fields stay
-- Auto, only the ones the creator actually touched are pinned.
ALTER TABLE public.code_surprises
  ADD COLUMN IF NOT EXISTS sensory_settings jsonb;

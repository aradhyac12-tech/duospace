-- Found while investigating a report of photo/file/camera-photo sends
-- failing: two earlier migrations (20260308224547_... and
-- 20260511075549_...) both run an unguarded
--   INSERT INTO storage.buckets (id, name, public) VALUES ('chat-files', ...)
-- (same pattern repeats for 'gallery', 'avatars', 'memories' in the second
-- one). Postgres INSERT with no ON CONFLICT clause raises a duplicate-key
-- error on `storage.buckets`'s primary key (id) the second time it runs.
-- On THIS project's live database that's almost certainly already water
-- under the bridge — the buckets clearly exist and have been working, so
-- whichever of the two ran first succeeded historically and this specific
-- landmine isn't the live cause of the current send failures. But it's a
-- real, sharp landmine for anyone replaying migrations from scratch (a
-- fresh environment, CI, or disaster recovery) — that replay would abort
-- partway through the SECOND migration file, at whichever bucket line hits
-- the duplicate first, taking down every other statement below it in that
-- same file. This migration doesn't try to edit the old files (already
-- applied, editing history after the fact doesn't change what a live DB's
-- migration-tracking table thinks already ran) — it just re-affirms the
-- same 4 bucket rows the idempotent way, safe to run any number of times,
-- so a from-scratch replay stops hitting this specific wall going forward.
INSERT INTO storage.buckets (id, name, public) VALUES ('chat-files', 'chat-files', false)
  ON CONFLICT (id) DO NOTHING;
INSERT INTO storage.buckets (id, name, public) VALUES ('gallery', 'gallery', false)
  ON CONFLICT (id) DO NOTHING;
INSERT INTO storage.buckets (id, name, public) VALUES ('avatars', 'avatars', false)
  ON CONFLICT (id) DO NOTHING;
INSERT INTO storage.buckets (id, name, public) VALUES ('memories', 'memories', false)
  ON CONFLICT (id) DO NOTHING;

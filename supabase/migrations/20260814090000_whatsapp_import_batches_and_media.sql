-- WHATSAPP IMPORT: undo support + richer content types (media/calls)
--
-- Previously every row inserted by ImportSettings.tsx had no way to be
-- grouped back into "the import that just ran" — ImportSettings.tsx's own
-- disclosure copy said plainly "there's currently no bulk or per-message
-- delete for imported history yet". This adds an import_batch_id (one
-- generated client-side per file the user imports) so a whole import run
-- can be selected and deleted together — "Undo import".
--
-- file_url/file_type columns already existed on this table (added in the
-- original 20260707054831 baseline) but nothing ever populated them —
-- ImportSettings.tsx only ever inserted text rows. That's fixed in this
-- same session's ImportSettings.tsx rewrite, which now also extracts
-- referenced media out of the WhatsApp export .zip (photos/videos/audio/
-- documents) and detects the plain-text call-log lines WhatsApp exports
-- inline in the chat transcript ("Voice call", "Missed video call", ...),
-- tagging both with file_type so the timeline can render them distinctly
-- from plain imported text bubbles instead of dumping raw junk lines.
ALTER TABLE public.imported_chats
  ADD COLUMN IF NOT EXISTS import_batch_id uuid;

CREATE INDEX IF NOT EXISTS idx_imported_chats_batch
  ON public.imported_chats (owner_id, import_batch_id);

-- file_type has been free-text with a 'text' default since the original
-- migration; constrain it now that real values are actually being written,
-- so a typo in future import code fails loudly at insert time instead of
-- silently producing a file_type the timeline UI doesn't know how to
-- render.
ALTER TABLE public.imported_chats DROP CONSTRAINT IF EXISTS imported_chats_file_type_check;
ALTER TABLE public.imported_chats
  ADD CONSTRAINT imported_chats_file_type_check
  CHECK (file_type IN ('text', 'image', 'video', 'audio', 'document', 'call'));

-- Undo needs a DELETE surface scoped to (owner, batch) — the existing
-- "Delete own imported chats" policy (auth.uid() = owner_id) already covers
-- this correctly since import_batch_id is just an extra filter on top of
-- that same ownership check; no policy change needed, this comment just
-- documents that it was checked, not skipped.

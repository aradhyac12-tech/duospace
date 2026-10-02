-- Chat Reliability v2 — stable client-generated message identity.
--
-- ROOT CAUSE this closes: every message send today goes through a plain
-- `supabase.from("messages").insert(...)` with no idempotency key at all
-- (see src/pages/Chat.tsx attemptSendText / attemptSendMedia). The only
-- "stable id" that exists is `clientId` (a `pending-<uuid>`), and it is
-- 100% client-side/in-memory — it is never sent to the server, so the
-- server has no way to recognize "this exact send was already accepted"
-- versus "this is a new message". Concretely:
--   * a retry after a lost HTTP response (request succeeded server-side,
--     but the client never saw the 2xx) creates a second row — same user
--     action, two canonical messages (violates Invariant 1/2);
--   * offline-queued text sends (src/lib/pendingSendQueue.ts) are
--     deliberately NOT auto-resent on reconnect today specifically
--     because there is no safe idempotent insert path — see the comment
--     above the rehydrate-pending-text effect in Chat.tsx — and instead
--     fall back to a fragile "same content within a 5-minute window"
--     heuristic to decide whether a queued send already went through,
--     which is exactly the "content + created_at proximity" identity
--     anti-pattern this whole effort exists to remove, and can misfire
--     on legitimately repeated text ("okay" / "okay" / "okay").
--
-- FIX: add a client-generated `client_message_id` column that travels
-- with the insert and is enforced unique at the database level, so a
-- retried/duplicate insert of the same logical send is rejected by
-- Postgres (23505 unique_violation) rather than silently creating a
-- second row. The application layer (Chat.tsx) catches that specific
-- error code and fetches the already-created canonical row instead of
-- surfacing it as a failure — see the accompanying application change.
--
-- Nullable + a PARTIAL unique index (not a table-level UNIQUE constraint):
--   * every historical message (and every message inserted through a path
--     not yet updated to send this field — scheduled messages, imported
--     WhatsApp history, love letters, surprises, call-event rows, etc.)
--     has no client_message_id and must remain valid — see spec section
--     39, "existing messages may not have client_message_id, handle
--     legacy messages safely";
--   * a plain `UNIQUE` constraint on a nullable column already treats
--     multiple NULLs as non-conflicting in Postgres, so a partial index
--     is not strictly required for correctness here, but is used anyway
--     to be explicit about intent (this constraint is about deduplicating
--     genuine client-originated sends, not about NULL bookkeeping) and to
--     keep the index small (it only indexes rows that actually carry the
--     key, which is what every lookup by client_message_id filters on).
--
-- Forward-only: this is a new migration, no historical migration files
-- are modified.

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS client_message_id uuid;

-- One client_message_id -> one canonical message row, globally. A
-- client_message_id is generated once per send attempt on the sending
-- device (crypto.randomUUID()) and reused verbatim across every retry of
-- that same attempt, so global uniqueness (not scoped to sender_id) is
-- the correct invariant: it is not meaningful for two different rows to
-- ever share the same client_message_id regardless of who sent them.
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_message_id
  ON public.messages (client_message_id)
  WHERE client_message_id IS NOT NULL;

COMMENT ON COLUMN public.messages.client_message_id IS
  'Client-generated idempotency key (UUID) set at send time and reused on every retry of the same send attempt. NULL for legacy messages and for rows inserted through paths not yet updated to set it (see docs/CHAT_RELIABILITY_V2.md). Enforced unique via idx_messages_client_message_id so a retried insert of the same attempt cannot create a duplicate canonical message.';

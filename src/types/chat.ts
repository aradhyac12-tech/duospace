// ─── Chat domain types ─────────────────────────────────────────────────────
// Extracted from pages/Chat.tsx (Phase 3 UI/state decomposition) so both
// Chat.tsx and the decomposed presentational components in components/chat/
// share one definition instead of duplicating or importing across each other.

export interface Message {
  id: string;
  content: string | null;
  sender_id: string;
  receiver_id: string;
  message_type: string;
  file_url: string | null;
  file_name: string | null;
  created_at: string;
  is_read: boolean;
  reply_to_id: string | null;
  disappear_at: string | null;
  edited_at?: string | null;
  is_pinned?: boolean;
  /**
   * Chat Reliability v2 — stable client-generated idempotency key (UUID),
   * set once at send time (Chat.tsx derives it from the optimistic
   * bubble's `pending-<uuid>` clientId) and reused verbatim on every
   * retry of that same send attempt. Enforced unique at the DB level
   * (idx_messages_client_message_id) so a retried insert of an attempt
   * that actually already succeeded cannot create a duplicate canonical
   * message. `null`/`undefined` for legacy messages and for any insert
   * path not yet updated to set it — see supabase/migrations/
   * 20260910130000_messages_client_message_id_idempotency.sql.
   */
  client_message_id?: string | null;
}

export interface DecryptedMessage extends Message {
  /** /silent — sent without a push notification. */
  silent?: boolean | null;
  /** /important — push bypasses Do Not Disturb / mute. */
  important?: boolean | null;
  /** /urgent — like important, shown with the strongest (red) treatment. */
  urgent?: boolean | null;
  decryptedContent: string | null;
  /**
   * Optimistic-send UI state — client-only, never persisted, absent for
   * every message that actually came from the DB (the overwhelming
   * majority). Added so tapping Send shows the message immediately
   * instead of waiting for the round trip: "sending" while the insert/
   * upload is in flight, "failed" if it errored (and can be retried).
   */
  _sendStatus?: "sending" | "failed";
  /** 0-100 upload progress for a media message's `_sendStatus: "sending"`
   *  state, from resumableUpload's onProgress callback. Undefined for text
   *  (no upload — sending is near-instant) and once a media upload
   *  actually starts moving bytes rather than still queued at 0. */
  _uploadProgress?: number;
  /** Local blob: URL for a media message that's still uploading, so the
   *  photo/video/voice-note is visible/playable immediately rather than
   *  showing a blank placeholder until the real remote URL exists. Always
   *  paired with _sendStatus and revoked (URL.revokeObjectURL) once the
   *  real message replaces this optimistic one. */
  _localPreviewUrl?: string;
  /**
   * Client-only: the storage path of this message's media, kept when the
   * message was loaded from the on-device store and its file_url couldn't be
   * resolved (media not cached + offline). Lets the store re-persist the row
   * without losing the path. Never sent to the server.
   */
  _mediaPath?: string | null;
}

export interface CallEntry {
  id: string;
  caller_id: string;
  receiver_id: string | null;
  call_type: string;
  status: string;
  call_direction: string;
  duration_seconds: number | null;
  created_at: string;
  /** See src/lib/callOutcome.ts — needed to tell a plain unanswered call
   *  apart from one the receiver actively declined; both share
   *  status==='missed'. */
  declined_at?: string | null;
}

// WA-01 FIX: ImportedMessage so imported WhatsApp chats can be fetched
// from the DB and rendered in the timeline.
export interface ImportedMessage {
  id: string;
  sender_name: string;
  content: string | null;
  original_timestamp: string;
  created_at: string;
  is_self: boolean;
  // Undo-import + rich-content fields (media/call rows from a WhatsApp
  // export, not just plain text). file_type defaults to "text" server-side
  // for pre-existing rows imported before these columns were populated.
  file_url: string | null;
  file_type: "text" | "image" | "video" | "audio" | "document" | "call";
  import_batch_id: string | null;
  // Per-viewer hide list for "Clear chat" — see the
  // imported_chats_per_viewer_clear migration. Selected but not read
  // directly client-side; filtering happens in the query itself
  // (.not("cleared_by","cs",...)) so this is mostly here for completeness
  // of what the row actually contains.
  cleared_by?: string[];
}

import type { EngineSurprise } from "@/lib/surpriseEngine";

export type TimelineItem =
  | { type: "message";  data: DecryptedMessage }
  | { type: "call";     data: CallEntry }
  | { type: "imported"; data: ImportedMessage }
  | { type: "surprise"; data: EngineSurprise };

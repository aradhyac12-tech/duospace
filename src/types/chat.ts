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
}

export interface DecryptedMessage extends Message {
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

export type TimelineItem =
  | { type: "message";  data: DecryptedMessage }
  | { type: "call";     data: CallEntry }
  | { type: "imported"; data: ImportedMessage };

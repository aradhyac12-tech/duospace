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
}

export type TimelineItem =
  | { type: "message";  data: DecryptedMessage }
  | { type: "call";     data: CallEntry }
  | { type: "imported"; data: ImportedMessage };

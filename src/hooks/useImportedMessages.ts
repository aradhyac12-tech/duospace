import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { resolveSignedUrl } from "@/lib/signedStorageUrl";
import type { ImportedMessage } from "@/types/chat";

/**
 * Fetches this couple's imported_chats rows (from WhatsApp import) and
 * keeps them in sync via realtime INSERT/DELETE — both partners' rows are
 * watched (see WA-08 fix below), and rows the viewer has cleared are
 * excluded the same way `messages` excludes deleted_by_sender/receiver.
 *
 * Extracted out of Chat.tsx (Phase-2 internal-architecture pass) —
 * behavior, query shape, dedup-by-id, and cleanup are unchanged. Exposes
 * `refetch` (used by recoverChat) and `clear` (used by clearChat to blank
 * local state immediately after the clear RPC succeeds) instead of the
 * raw setter, so Chat.tsx has no direct write access to this hook's state.
 *
 * WA-01 FIX (preserved from original): imported_chats was write-only
 * before — inserted but never queried — so imported messages never
 * appeared anywhere in the UI.
 * WA-08 FIX (preserved from original): fetch/subscribe cover both
 * owner_id values so whichever partner did NOT run the import still sees
 * the imported chat, matching what RLS already allowed.
 */
export function useImportedMessages(user: { id: string } | null | undefined, partnerId: string | null) {
  const [importedMessages, setImportedMessages] = useState<ImportedMessage[]>([]);

  const resolveImportedUrls = useCallback((rows: ImportedMessage[]) =>
    Promise.all(rows.map(async r => ({
      ...r,
      // Imported media is uploaded to the same private "chat-files"
      // bucket as everything else — resolve to a signed URL the same way
      // real message attachments are.
      file_url: r.file_url ? await resolveSignedUrl("chat-files", r.file_url) : r.file_url,
    }))), []);

  const refetch = useCallback(async () => {
    if (!user || !partnerId) return;
    const { data } = await supabase
      .from("imported_chats" as any)
      .select("id,sender_name,content,original_timestamp,created_at,is_self,file_url,file_type,import_batch_id,cleared_by")
      .in("owner_id", [user.id, partnerId])
      // Read side of the clearChat fix — rows the viewer has cleared
      // (their own uid present in cleared_by) are excluded.
      .not("cleared_by", "cs", `{${user.id}}`)
      .order("original_timestamp", { ascending: true });
    if (data) setImportedMessages(await resolveImportedUrls(data as unknown as ImportedMessage[]));
  }, [user, partnerId, resolveImportedUrls]);

  useEffect(() => {
    if (!user || !partnerId) return;
    refetch();
    // postgres_changes only supports one equality filter per listener, so
    // register one per owner_id per event and dedupe by row id.
    const seenIds = new Set<string>();
    const handleInsert = async (payload: { new: Record<string, unknown> }) => {
      const row = payload.new as unknown as ImportedMessage;
      if (seenIds.has(row.id)) return;
      seenIds.add(row.id);
      const [resolved] = await resolveImportedUrls([row]);
      setImportedMessages(prev => prev.some(m => m.id === resolved.id) ? prev : [...prev, resolved]);
    };
    const handleDelete = (payload: { old: Record<string, unknown> }) => {
      const id = (payload.old as any)?.id;
      if (id) setImportedMessages(prev => prev.filter(m => m.id !== id));
    };
    const ch = supabase.channel(`imported-rt-${[user.id, partnerId].sort().join("-")}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "imported_chats",
          filter: `owner_id=eq.${user.id}` }, handleInsert)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "imported_chats",
          filter: `owner_id=eq.${partnerId}` }, handleInsert)
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "imported_chats",
          filter: `owner_id=eq.${user.id}` }, handleDelete)
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "imported_chats",
          filter: `owner_id=eq.${partnerId}` }, handleDelete)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [user, partnerId, refetch, resolveImportedUrls]);

  const clear = useCallback(() => setImportedMessages([]), []);

  return { importedMessages, refetch, clear };
}

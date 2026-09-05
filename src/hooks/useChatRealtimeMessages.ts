import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { resolveSignedUrl } from "@/lib/signedStorageUrl";
import { dispatchEmojiEffect } from "@/components/EmojiScreenEffect";
import { playMessageSound } from "@/lib/sounds";
import { hapticMedium } from "@/lib/haptics";
import type { Message, DecryptedMessage } from "@/types/chat";

type SetMessages = React.Dispatch<React.SetStateAction<DecryptedMessage[]>>;
type SetPinnedMsg = React.Dispatch<React.SetStateAction<DecryptedMessage | null>>;

/**
 * Owns the `messages-rt-${userId}` channel: INSERT (decrypt + signed-URL
 * resolve + merge, with nudge-flash/sound/love-emoji reactions for
 * partner-sent messages), UPDATE (edits, read receipts, pin/unpin,
 * disappear_at), and DELETE.
 *
 * Extracted out of Chat.tsx (Phase-2 internal-architecture pass,
 * increment 2) — every dedup rule, filter, and decrypt/resolve path is
 * unchanged. `messages` itself stays owned by Chat.tsx (it's also written
 * by fetchMessages, pagination, send/retry, and message actions — moving
 * only the realtime listener while leaving the rest in place is the
 * honest boundary here; the state is shared, only this channel's
 * subscribe/cleanup lifecycle is independent), so this hook takes the
 * setters it needs rather than owning the state itself.
 */
export function useChatRealtimeMessages(
  user: { id: string } | null | undefined,
  decrypt: (content: string) => Promise<string>,
  setMessages: SetMessages,
  setPinnedMsg: SetPinnedMsg,
  setNudgeFlash: React.Dispatch<React.SetStateAction<boolean>>,
) {
  useEffect(() => {
    if (!user) return;
    // FIX BUG-02: Use unique channel name per user to avoid cross-user subscriptions.
    // Also add server-side filter on INSERT so only messages where the current user
    // is sender or receiver are delivered. Without this filter every client received
    // every INSERT on the entire table, leaking metadata (sender_id, receiver_id,
    // file_url, timestamps) to all authenticated users.
    // Note: Supabase postgres_changes only supports a single equality filter per listener,
    // so we register two INSERT listeners — one for receiver_id and one for sender_id —
    // and deduplicate by message ID in the handler.
    const seenIds = new Set<string>();
    const handleInsert = async (payload: { new: Record<string, unknown> }) => {
      const msg = payload.new as unknown as Message;
      if (seenIds.has(msg.id)) return; // deduplicate the two listeners
      seenIds.add(msg.id);
      let dm: DecryptedMessage;
      let decrypted: string | null = null;
      try {
        decrypted = (msg.message_type==="text"||msg.message_type==="letter")
          ? await decrypt(msg.content) : msg.content;
        // resolveSignedUrl returns null on failure — fall back to raw file_url
        const resolvedFileUrl = msg.file_url ? (await resolveSignedUrl("chat-files", msg.file_url)) ?? msg.file_url : msg.file_url;
        dm = { ...msg, decryptedContent: decrypted, file_url: resolvedFileUrl };
      } catch {
        // Per-message error isolation: signing/decryption failure must not
        // prevent the message from appearing in the chat.
        dm = { ...msg, decryptedContent: msg.content } as DecryptedMessage;
      }
      // FIX: guard against a message already present from the initial fetchMessages()
      // load (or a realtime reconnect replay) being appended a second time — seenIds
      // above only dedupes the two postgres_changes listeners on this channel, not
      // against messages already in state.
      // Also dedup against optimistic messages that may still have a different ID
      // ("pending-xxx" vs the real UUID) but represent the same logical message.
      setMessages(prev => {
        if (prev.some(m => m.id === dm.id)) return prev;
        // Check for an optimistic bubble with a pending ID that matches
        const hasOptimisticTwin = prev.some(m =>
          m.id.startsWith("pending-") &&
          m.sender_id === dm.sender_id &&
          m.receiver_id === dm.receiver_id &&
          m.message_type === dm.message_type &&
          m.content === dm.content
        );
        if (hasOptimisticTwin) return prev; // server version will be picked up by fetchMessages
        return [...prev, dm];
      });
      if (msg.sender_id !== user.id) {
        // Nudge flash
        if (msg.message_type==="nudge") {
          setNudgeFlash(true);
          hapticMedium();
          setTimeout(() => setNudgeFlash(false), 1500);
        }
        playMessageSound();
        if (decrypted) {
          const loveEmojis = ["❤️","♥️","💕","💖","💗","😍","🥰","💘","💝"];
          for (const e of loveEmojis) { if (decrypted.includes(e)) { dispatchEmojiEffect(e); break; } }
        }
      }
    };
    const ch = supabase.channel(`messages-rt-${user.id}`)
      .on("postgres_changes",{ event:"INSERT",schema:"public",table:"messages",filter:`receiver_id=eq.${user.id}` }, handleInsert)
      .on("postgres_changes",{ event:"INSERT",schema:"public",table:"messages",filter:`sender_id=eq.${user.id}` }, handleInsert)
      .on("postgres_changes",{ event:"DELETE",schema:"public",table:"messages" }, (payload) => {
        const id = (payload.old as any)?.id;
        if (id) setMessages(prev => prev.filter(m => m.id!==id));
      })
      .on("postgres_changes",{ event:"UPDATE",schema:"public",table:"messages" }, async (payload) => {
        const updated = payload.new as Message;
        if ((updated as any).deleted_by_sender||(updated as any).deleted_by_receiver) {
          setMessages(prev => prev.filter(m => m.id!==updated.id)); return;
        }
        // FIX: re-decrypt edited content
        const newContent = (updated.message_type==="text"||updated.message_type==="letter")
          ? await decrypt(updated.content) : updated.content;
        setMessages(prev => prev.map(m => m.id===updated.id
          ? { ...m, is_read:updated.is_read, disappear_at:updated.disappear_at,
              content:updated.content, decryptedContent:newContent,
              edited_at:(updated as any).edited_at, is_pinned:(updated as any).is_pinned }
          : m));
        // Update pinned banner
        if ((updated as any).is_pinned) {
          const dm: DecryptedMessage = { ...updated, decryptedContent: newContent };
          setPinnedMsg(dm);
        } else if (!(updated as any).is_pinned) {
          setPinnedMsg(prev => prev?.id===updated.id ? null : prev);
        }
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [user, decrypt, setMessages, setPinnedMsg, setNudgeFlash]);
}

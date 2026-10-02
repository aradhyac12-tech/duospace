import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/appClient";
import { resolveSignedUrl } from "@/lib/signedStorageUrl";
import { isVanishValue } from "@/lib/chatConstants";
import { markVanishMedia, forgetVanishMedia } from "@/lib/vanishMedia";
import { dispatchEmojiEffect } from "@/components/EmojiScreenEffect";
import { playMessageSound } from "@/lib/sounds";
import { messageAlertLevel, startInAppMessageAlert } from "@/lib/messageAlert";
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
  // GAP-DETECTION FIX (spec section 5): postgres_changes has no backlog —
  // if this channel's socket drops (server-side idle kill, load-balancer
  // timeout, brief connectivity blip that never flips navigator.onLine)
  // and reconnects, any INSERT/UPDATE/DELETE that happened during the gap
  // is gone for good unless something re-fetches. useReconnectRefetch in
  // Chat.tsx already covers browser online/foreground transitions, but a
  // realtime-socket-level drop can happen with the tab staying foregrounded
  // and the OS staying "online" the whole time (Supabase's client still
  // reconnects the socket automatically, it just doesn't replay history).
  // Passing the same fetchMessages() here lets this hook trigger a resync
  // any time the channel actually re-subscribes after having subscribed
  // once already — i.e. a real reconnect, not the initial mount.
  onResync?: () => void,
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
        // Vanish media must never reach the on-device cache — register it
        // before the URL is resolved.
        markVanishMedia(msg);
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
      // Also dedup against the optimistic bubble that may still have a different ID
      // ("pending-xxx" vs the real UUID) but represents the same logical message —
      // that bubble's own HTTP round trip (attemptSendText/attemptSendMedia in
      // Chat.tsx) is what actually swaps it for the canonical row in place, so this
      // just needs to avoid adding a SECOND copy while that's in flight.
      //
      // CHAT RELIABILITY v2: this used to match by sender_id+receiver_id+
      // message_type+content — exactly the "content proximity" identity
      // anti-pattern this effort exists to remove. It could not
      // distinguish between two GENUINELY distinct, legitimately identical
      // messages (spec's own "okay"/"okay"/"okay" example): if a second,
      // unrelated optimistic "okay" happened to be in flight when this
      // INSERT arrived, the heuristic could match the wrong bubble and
      // suppress a message that no other code path was going to insert —
      // silent, permanent message loss, not just a visual duplicate.
      // Matching on client_message_id is exact: a `pending-<uuid>` bubble
      // represents this exact canonical row if and only if its clientId's
      // UUID equals the row's client_message_id (there is no other way
      // for the two to share that value — it's a server-enforced unique
      // key, see idx_messages_client_message_id). Falls through to the
      // plain "add it" path for legacy rows with no client_message_id.
      setMessages(prev => {
        if (prev.some(m => m.id === dm.id)) return prev;
        const cmid = dm.client_message_id;
        const hasOptimisticTwin = !!cmid && prev.some(m => m.id === `pending-${cmid}`);
        if (hasOptimisticTwin) return prev; // the bubble's own HTTP response will swap it for `dm` in place
        return [...prev, dm];
      });
      if (msg.sender_id !== user.id) {
        // Nudge flash
        if (msg.message_type==="nudge") {
          setNudgeFlash(true);
          hapticMedium();
          setTimeout(() => setNudgeFlash(false), 1500);
        }
        // /important and /urgent used to get the same plain ping as anything
        // else. With the chat open the server suppresses the push, so this
        // realtime insert is the only signal — ring the tier's own long sound +
        // haptic pattern instead (see lib/messageAlert.ts).
        // The generated Message type predates the important/urgent columns;
        // the realtime row carries them (see migrations), so narrow explicitly.
        const alertLevel = messageAlertLevel(msg as { important?: boolean | null; urgent?: boolean | null });
        if (alertLevel) startInAppMessageAlert(alertLevel);
        else playMessageSound();
        if (decrypted) {
          const loveEmojis = ["❤️","♥️","💕","💖","💗","😍","🥰","💘","💝"];
          for (const e of loveEmojis) { if (decrypted.includes(e)) { dispatchEmojiEffect(e); break; } }
        }
      }
    };
    // CHAT RELIABILITY v2: previously deliberately UNFILTERED — see the
    // long comment this replaced (still true historically, kept in spirit
    // below) explaining that the default REPLICA IDENTITY (primary key
    // only) meant a DELETE's old-row payload carried only `id`, with
    // nothing to filter on. supabase/migrations/
    // 20260910160000_messages_replica_identity_full.sql sets REPLICA
    // IDENTITY FULL specifically so the old row now carries every column
    // — including sender_id/receiver_id — making the same two-listener
    // filter pattern already used for INSERT/UPDATE possible here too.
    // Closes the same "every client receives every delete table-wide"
    // exposure already fixed for INSERT/UPDATE (BUG-02) and for
    // `message_reactions` (see MessageReactions.tsx).
    const seenDeleteIds = new Set<string>();
    const handleDelete = (payload: { old: Record<string, unknown> }) => {
      const id = (payload.old as any)?.id;
      if (!id || seenDeleteIds.has(id)) return; // dedupe the two listeners below
      seenDeleteIds.add(id);
      setMessages(prev => prev.filter(m => m.id!==id));
      // Vanish Mode: the other person just ended the session (or left after
      // seeing it). The row is gone — make sure this device keeps no copy of
      // its photo / video / file / voice note either. (REPLICA IDENTITY FULL
      // means the old row carries file_url and disappear_at; if they're
      // missing this is just a no-op.)
      const old = payload.old as { file_url?: string | null; disappear_at?: string | null };
      if (old?.file_url && isVanishValue(old.disappear_at)) void forgetVanishMedia(old.file_url);
    };
    const seenUpdateIds = new Map<string, number>(); // id -> updated_at ms, so a genuinely newer update to the same id isn't dropped
    // SECURITY/PERF FIX: this listener used to have no filter at all —
    // every authenticated client received every UPDATE on the entire
    // `messages` table. Same two-listener sender_id/receiver_id pattern
    // as INSERT (postgres_changes only supports one equality filter per
    // listener), deduped by id below. Safe to filter on
    // `new.sender_id`/`new.receiver_id` because an UPDATE's WAL record
    // always carries the complete new row regardless of replica identity.
    const handleUpdate = async (payload: { new: Record<string, unknown> }) => {
      const updated = payload.new as unknown as Message;
      const updatedAtMs = (updated as any).edited_at ? Date.parse((updated as any).edited_at) : Date.now();
      const lastSeen = seenUpdateIds.get(updated.id);
      if (lastSeen !== undefined && lastSeen >= updatedAtMs) return; // duplicate of the two listeners, or a stale replay
      seenUpdateIds.set(updated.id, updatedAtMs);
      if ((updated as any).deleted_by_sender||(updated as any).deleted_by_receiver) {
        setMessages(prev => prev.filter(m => m.id!==updated.id)); return;
      }
      // FIX: re-decrypt edited content. Wrapped in try/catch — this can
      // legitimately throw (e.g. a stale key during E2E key rotation) and
      // must not crash the shared realtime handler for every other
      // update.
      let newContent: string;
      try {
        newContent = (updated.message_type==="text"||updated.message_type==="letter")
          ? await decrypt(updated.content) : updated.content;
      } catch {
        newContent = updated.content;
      }
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
    };
    let hasSubscribedBefore = false;
    const ch = supabase.channel(`messages-rt-${user.id}`)
      .on("postgres_changes",{ event:"INSERT",schema:"public",table:"messages",filter:`receiver_id=eq.${user.id}` }, handleInsert)
      .on("postgres_changes",{ event:"INSERT",schema:"public",table:"messages",filter:`sender_id=eq.${user.id}` }, handleInsert)
      .on("postgres_changes",{ event:"DELETE",schema:"public",table:"messages",filter:`receiver_id=eq.${user.id}` }, handleDelete)
      .on("postgres_changes",{ event:"DELETE",schema:"public",table:"messages",filter:`sender_id=eq.${user.id}` }, handleDelete)
      .on("postgres_changes",{ event:"UPDATE",schema:"public",table:"messages",filter:`receiver_id=eq.${user.id}` }, handleUpdate)
      .on("postgres_changes",{ event:"UPDATE",schema:"public",table:"messages",filter:`sender_id=eq.${user.id}` }, handleUpdate)
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          if (hasSubscribedBefore) {
            // A genuine resubscribe after the socket dropped, not the
            // initial mount — postgres_changes has no replay, so resync
            // from the DB to recover anything that happened in the gap.
            onResync?.();
          }
          hasSubscribedBefore = true;
        }
      });
    return () => { supabase.removeChannel(ch); };
  }, [user, decrypt, setMessages, setPinnedMsg, setNudgeFlash, onResync]);
}

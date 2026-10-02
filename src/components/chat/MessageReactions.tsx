import { hapticSelection } from "@/lib/haptics";
import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { supabase } from "@/integrations/supabase/appClient";

const EMOJI_OPTIONS = ["❤️", "😂", "👍", "😮", "😢", "🔥"];

interface Reaction {
  id: string;
  emoji: string;
  user_id: string;
  message_id: string;
  created_at: string;
}

interface MessageReactionsProps {
  messageId: string;
  userId: string;
  isMine: boolean;
  // B1 Fix: reactions injected from parent's single channel instead of each component subscribing
  allReactions?: Reaction[];
  // UI-02 Fix: the emoji picker used to render as a permanently-visible button
  // under EVERY bubble (even ones with zero reactions), which padded out the
  // height of every message and made the chat look bloated. It's now opened
  // externally — from the long-press context menu's "React" action — and this
  // component only takes up space when there's something to actually show.
  pickerOpen?: boolean;
  onPickerClose?: () => void;
}

// B1 Fix: Export a hook that owns ONE channel for all reactions in a conversation.
// The Chat page uses this and passes reactions down as props.
export const useReactionsChannel = (userId: string | undefined, partnerId: string | null) => {
  const [reactions, setReactions] = useState<Reaction[]>([]);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  const fetchAll = useCallback(async () => {
    if (!userId || !partnerId) return;
    // Fetch reactions for messages between this couple only
    const { data } = await supabase
      .from("message_reactions")
      .select("id,message_id,user_id,emoji,created_at")
      .order("created_at" as any, { ascending: true });
    if (data) setReactions(data as Reaction[]);
  }, [userId, partnerId]);

  useEffect(() => {
    if (!userId || !partnerId) return;
    fetchAll();

    // ONE channel for all reactions in this conversation.
    //
    // CHAT RELIABILITY v2 findings, fixed here:
    //
    // 1. LEAK: this listener had no `filter` at all — `{event:"*",
    //    schema:"public", table:"message_reactions"}` with nothing
    //    scoping it. This codebase already established, for the sibling
    //    `messages` realtime channel (see useChatRealtimeMessages.ts's
    //    "FIX BUG-02" comment), that RLS alone does NOT scope
    //    postgres_changes delivery in this project — an unfiltered
    //    listener receives every row change table-wide, to every
    //    authenticated client, regardless of the channel's own name.
    //    The channel being named `reactions-convo-${pair}` never scoped
    //    anything server-side; it was purely a client-side label. That
    //    means every reaction (message_id, user_id, emoji) on every
    //    OTHER couple's conversation was being delivered to this client
    //    too. Fixed the same way BUG-02 was: two equality-filtered
    //    listeners (postgres_changes supports only one equality filter
    //    per listener) — `user_id=eq.<self>` and `user_id=eq.<partner>`
    //    — which correctly scopes to just this pair, since any reaction
    //    relevant to this conversation is authored by one of these two
    //    people (RLS's own INSERT policy enforces `user_id = auth.uid()`).
    //
    // 2. DUPLICATE: the INSERT branch appended `payload.new`
    //    unconditionally — no id check. Realtime delivery must be
    //    assumed to be at-least-once (the brief's own framing), and
    //    subscribing while `fetchAll()` is still in flight above is
    //    itself a race that can double-deliver a reaction that landed in
    //    the initial fetch AND arrives as its own INSERT event. Now
    //    deduped by id, same as the two-listener dedup pattern used for
    //    `messages`.
    const seenReactionIds = new Set<string>();
    const handleChange = (payload: any) => {
      if (payload.eventType === "INSERT") {
        const id = (payload.new as any)?.id;
        if (!id || seenReactionIds.has(id)) return;
        seenReactionIds.add(id);
        setReactions(prev => prev.some(r => r.id === id) ? prev : [...prev, payload.new as Reaction]);
      } else if (payload.eventType === "DELETE") {
        setReactions(prev => prev.filter(r => r.id !== (payload.old as any).id));
      } else if (payload.eventType === "UPDATE") {
        setReactions(prev => prev.map(r => r.id === (payload.new as any).id ? payload.new as Reaction : r));
      }
    };
    const channel = supabase
      .channel(`reactions-convo-${[userId, partnerId].sort().join("-")}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "message_reactions", filter: `user_id=eq.${userId}` }, handleChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "message_reactions", filter: `user_id=eq.${partnerId}` }, handleChange)
      .subscribe();

    channelRef.current = channel;
    return () => { supabase.removeChannel(channel); };
  }, [userId, partnerId, fetchAll]);

  return reactions;
};

const MessageReactions = ({ messageId, userId, isMine, allReactions, pickerOpen, onPickerClose }: MessageReactionsProps) => {
  // B1: If allReactions provided from parent channel, use those. Otherwise fall back to local fetch.
  const [localReactions, setLocalReactions] = useState<Reaction[]>([]);
  const [showPicker, setShowPicker] = useState(false);

  // Opened externally (long-press → React), rather than by a button that
  // used to live inline in every bubble.
  useEffect(() => { if (pickerOpen) setShowPicker(true); }, [pickerOpen]);
  const closePicker = useCallback(() => { setShowPicker(false); onPickerClose?.(); }, [onPickerClose]);

  // Only do local fetch if parent didn't inject reactions (backward compat)
  useEffect(() => {
    if (allReactions !== undefined) return;
    supabase
      .from("message_reactions")
      .select("id,message_id,user_id,emoji,created_at")
      .eq("message_id", messageId)
      .then(({ data }) => { if (data) setLocalReactions(data as Reaction[]); });
  }, [messageId, allReactions]);

  const reactions = allReactions !== undefined
    ? allReactions.filter(r => r.message_id === messageId)
    : localReactions;

  // RACE FIX (Phase 4 adversarial audit — Chat/reaction race): the DB
  // constraint (message_reactions_message_id_user_id_key, migration
  // 20260722120000) already correctly enforces one reaction row per user
  // per message, but this used to still enforce it with a DELETE followed
  // by a separate INSERT — two round trips, not one atomic operation. Two
  // devices signed into the same account (phone + web, or two tabs) tapping
  // a reaction on the same message within the same race window could both
  // pass the "mine" check with the same existing row, both fire their own
  // DELETE (only one actually removes a row; the second is a harmless
  // no-op against an already-gone id), and then both attempt their own
  // INSERT for the same (message_id, user_id) pair — the second INSERT
  // then hits the unique constraint and fails outright (23505), silently,
  // since the result's `error` was never checked. That device's tap would
  // appear to do nothing and its local reaction state would drift from the
  // server's until the next realtime event/refetch reconciled it — not a
  // cross-user data leak, but exactly the local-state-vs-server race this
  // audit asked to close.
  //
  // Fixed by collapsing "remove mine" + "replace mine" into a single
  // upsert keyed on the same (message_id, user_id) unique constraint:
  // Postgres resolves a concurrent upsert conflict by waiting for the
  // other transaction's row lock and then applying ON CONFLICT DO UPDATE
  // to the same row, so two near-simultaneous taps can never violate the
  // constraint — the loser's upsert just becomes the row's final state
  // (last write wins on the same row, not a discarded/failed write).
  const toggleReaction = async (emoji: string) => {
    closePicker();
    hapticSelection();
    const mine = reactions.find((r) => r.user_id === userId);
    if (mine?.emoji === emoji) {
      // Tapping the same emoji again removes it — this is the one case an
      // upsert can't express (there's nothing to "replace" with), so it
      // stays a plain delete. A concurrent second removal of the same row
      // is naturally idempotent (deleting an already-gone id affects 0
      // rows, not an error).
      await supabase.from("message_reactions").delete().eq("id", mine.id);
      if (allReactions === undefined) setLocalReactions(prev => prev.filter(r => r.id !== mine.id));
      return;
    }
    const { data, error } = await supabase
      .from("message_reactions")
      .upsert({ message_id: messageId, user_id: userId, emoji }, { onConflict: "message_id,user_id" })
      .select()
      .single();
    if (error) return; // best-effort UI update — next realtime event/refetch will reconcile
    if (data && allReactions === undefined) {
      setLocalReactions(prev => [...prev.filter(r => r.user_id !== userId), data as Reaction]);
    }
  };

  const grouped = reactions.reduce<Record<string, { count: number; byMe: boolean }>>((acc, r) => {
    if (!acc[r.emoji]) acc[r.emoji] = { count: 0, byMe: false };
    acc[r.emoji].count++;
    if (r.user_id === userId) acc[r.emoji].byMe = true;
    return acc;
  }, {});

  const hasReactions = Object.keys(grouped).length > 0;
  if (!hasReactions && !showPicker) return null; // nothing to render — no more empty spacer under every bubble

  return (
    <div className={`flex flex-wrap items-center gap-1 mt-1 ${isMine ? "justify-end" : "justify-start"}`}>
      <AnimatePresence initial={false} mode="popLayout">
        {Object.entries(grouped).map(([emoji, { count, byMe }]) => (
          <motion.button key={emoji} layout onClick={() => toggleReaction(emoji)}
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 500, damping: 22 }}
            aria-label={`React with ${emoji}${count > 1 ? `, ${count} people` : ""}${byMe ? ", you reacted" : ""}`}
            aria-pressed={byMe}
            className={`text-xs px-1.5 py-0.5 rounded-full border transition-colors ${
              byMe ? "bg-primary/20 border-primary/30" : "bg-muted/50 border-border"
            }`}>
            {emoji} {count > 1 && <span className="text-[10px] text-muted-foreground">{count}</span>}
          </motion.button>
        ))}
      </AnimatePresence>
      {showPicker && (
        <div className="relative">
          <div className="fixed inset-0 z-40" onClick={closePicker} aria-hidden="true" />
          <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }}
            className={`absolute ${isMine ? "right-0" : "left-0"} bottom-0 z-50 flex gap-1 bg-card border border-border rounded-xl px-2 py-1.5 shadow-lg`}>
            {EMOJI_OPTIONS.map((emoji) => (
              <button key={emoji} onClick={() => toggleReaction(emoji)} aria-label={`React with ${emoji}`}
                className="text-base hover:scale-125 transition-transform px-0.5 min-h-11 min-w-6 flex items-center justify-center">
                {emoji}
              </button>
            ))}
          </motion.div>
        </div>
      )}
    </div>
  );
};

export default MessageReactions;

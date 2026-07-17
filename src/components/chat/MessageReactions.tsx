import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { SmilePlus } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

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

    // ONE channel for all reactions in this conversation
    const channel = supabase
      .channel(`reactions-convo-${[userId, partnerId].sort().join("-")}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "message_reactions" }, (payload) => {
        if (payload.eventType === "INSERT") {
          setReactions(prev => [...prev, payload.new as Reaction]);
        } else if (payload.eventType === "DELETE") {
          setReactions(prev => prev.filter(r => r.id !== (payload.old as any).id));
        } else if (payload.eventType === "UPDATE") {
          setReactions(prev => prev.map(r => r.id === (payload.new as any).id ? payload.new as Reaction : r));
        }
      })
      .subscribe();

    channelRef.current = channel;
    return () => { supabase.removeChannel(channel); };
  }, [userId, partnerId, fetchAll]);

  return reactions;
};

const MessageReactions = ({ messageId, userId, isMine, allReactions }: MessageReactionsProps) => {
  // B1: If allReactions provided from parent channel, use those. Otherwise fall back to local fetch.
  const [localReactions, setLocalReactions] = useState<Reaction[]>([]);
  const [showPicker, setShowPicker] = useState(false);

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

  const toggleReaction = async (emoji: string) => {
    setShowPicker(false);
    const existing = reactions.find((r) => r.user_id === userId && r.emoji === emoji);
    if (existing) {
      await supabase.from("message_reactions").delete().eq("id", existing.id);
      if (allReactions === undefined) setLocalReactions(prev => prev.filter(r => r.id !== existing.id));
    } else {
      const { data } = await supabase
        .from("message_reactions")
        .insert({ message_id: messageId, user_id: userId, emoji })
        .select()
        .single();
      if (data && allReactions === undefined) setLocalReactions(prev => [...prev, data as Reaction]);
    }
  };

  const grouped = reactions.reduce<Record<string, { count: number; byMe: boolean }>>((acc, r) => {
    if (!acc[r.emoji]) acc[r.emoji] = { count: 0, byMe: false };
    acc[r.emoji].count++;
    if (r.user_id === userId) acc[r.emoji].byMe = true;
    return acc;
  }, {});

  return (
    <div className={`flex flex-wrap items-center gap-1 mt-1 ${isMine ? "justify-end" : "justify-start"}`}>
      {Object.entries(grouped).map(([emoji, { count, byMe }]) => (
        <button key={emoji} onClick={() => toggleReaction(emoji)}
          className={`text-xs px-1.5 py-0.5 rounded-full border transition-colors ${
            byMe ? "bg-primary/20 border-primary/30" : "bg-muted/50 border-border"
          }`}>
          {emoji} {count > 1 && <span className="text-[10px] text-muted-foreground">{count}</span>}
        </button>
      ))}
      <div className="relative">
        <button onClick={() => setShowPicker(!showPicker)}
          className="h-5 w-5 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors">
          <SmilePlus className="h-3 w-3" />
        </button>
        <AnimatePresence>
          {showPicker && (
            <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }}
              className={`absolute ${isMine ? "right-0" : "left-0"} bottom-7 z-50 flex gap-1 bg-card border border-border rounded-xl px-2 py-1.5 shadow-lg`}>
              {EMOJI_OPTIONS.map((emoji) => (
                <button key={emoji} onClick={() => toggleReaction(emoji)}
                  className="text-base hover:scale-125 transition-transform px-0.5">
                  {emoji}
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};

export default MessageReactions;

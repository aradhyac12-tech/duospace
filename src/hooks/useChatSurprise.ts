import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import {
  EngineSurprise,
  fetchLatestSurpriseFromPartner,
  fetchSurpriseById,
  getSeenIds,
  markSeen,
  pickEntryDelayMs,
  recordSurpriseEvent,
  registerView,
} from "@/lib/surpriseEngine";

/**
 * Owns the entire surprise lifecycle for the Chat screen ONLY.
 * Nothing here mounts globally, and nothing here fires on app startup —
 * it only starts its delayed check once the chat screen itself is mounted.
 */
export const useChatSurprise = () => {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [partnerId, setPartnerId] = useState<string | null>(null);
  const [surprise, setSurprise] = useState<EngineSurprise | null>(null);
  const [visible, setVisible] = useState(false);
  const deepLinkHandled = useRef(false);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("profiles")
        .select("partner_id")
        .eq("user_id", user.id)
        .single();
      if (!cancelled) setPartnerId(data?.partner_id ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const openSurprise = useCallback(
    async (s: EngineSurprise, opts: { fromDeepLink?: boolean } = {}) => {
      setSurprise(s);
      setVisible(true);
      if (partnerId) markSeen(partnerId, s.id);
      if (user) {
        await recordSurpriseEvent(s.id, user.id, "received");
        await recordSurpriseEvent(s.id, user.id, "opened");
      }
      if (!opts.fromDeepLink) {
        await registerView(s);
      }
    },
    [partnerId, user]
  );

  // Deep link: /chat?surprise=<id> — works even if it's not "new" or from partner.
  useEffect(() => {
    if (deepLinkHandled.current) return;
    const id = searchParams.get("surprise");
    if (!id) return;
    deepLinkHandled.current = true;
    (async () => {
      const s = await fetchSurpriseById(id);
      if (s) await openSurprise(s, { fromDeepLink: true });
      const next = new URLSearchParams(searchParams);
      next.delete("surprise");
      setSearchParams(next, { replace: true });
    })();
  }, [searchParams, setSearchParams, openSurprise]);

  const checkForNewSurprise = useCallback(async () => {
    if (!user || !partnerId || surprise) return;
    const seen = getSeenIds(partnerId);
    const next = await fetchLatestSurpriseFromPartner(partnerId, seen);
    if (next) await openSurprise(next);
  }, [partnerId, user, surprise, openSurprise]);

  // Slow entry: only starts counting once chat + partner are ready — never on app boot.
  useEffect(() => {
    if (!partnerId || deepLinkHandled.current) return;
    const timeout = setTimeout(() => {
      checkForNewSurprise();
    }, pickEntryDelayMs());
    return () => clearTimeout(timeout);
  }, [partnerId, checkForNewSurprise]);

  useEffect(() => {
    if (!partnerId) return;
    const channel = supabase
      .channel("code-surprises-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "code_surprises" }, (payload) => {
        const creatorId = (payload.new as { creator_id?: string } | null)?.creator_id;
        if (creatorId === partnerId) checkForNewSurprise();
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [partnerId, checkForNewSurprise]);

  const close = useCallback(() => {
    setVisible(false);
    if (surprise && user) recordSurpriseEvent(surprise.id, user.id, "finished");
    setTimeout(() => setSurprise(null), 400);
  }, [surprise, user]);

  return { surprise, visible, close };
};

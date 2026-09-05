import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import {
  EngineSurprise,
  fetchSurpriseById,
  fetchSurprisesForConversation,
  fetchSurpriseEventStates,
  getReceivedIds,
  getSeenIds,
  markReceived,
  markSeen,
  recordSurpriseEvent,
  registerView,
} from "@/lib/surpriseEngine";
import { deriveSurpriseStage, type SurpriseStage } from "@/lib/surpriseLifecycle";
import { analyzeSurpriseContent, SurpriseHapticEngine } from "@/lib/surpriseHaptics";

/**
 * Owns the entire surprise lifecycle for the Chat screen ONLY.
 * Nothing here mounts globally, and nothing here fires on app startup —
 * it only starts fetching once the chat screen itself is mounted and a
 * partner is resolved.
 *
 * Surprise 2.0: this used to own a single "the one unseen surprise, if
 * any" and auto-pop it into a full overlay a few seconds after the chat
 * screen settled, with a real delay before it appeared. That timed
 * auto-takeover is gone, but a version of auto-opening is back by
 * explicit request: a genuinely NEW inbound surprise now opens straight
 * into the overlay itself, with no tap required — see the reasoning
 * inline above the effect that does it, below. What stays true from the
 * redesign brief is that the row is real chat history either way: this
 * fetches the whole conversation's surprises (both directions, like
 * messages/call history already do) so MessageTimeline can render one
 * inline SurpriseMessage per row, and that row is what you land back on
 * / can retap afterward — the auto-open doesn't replace it. `openSurprise`
 * also remains for the two other things that should still actively open
 * the overlay: someone deliberately tapping a SurpriseMessage (for
 * backlog, or to reopen one after closing it), or a deep link.
 */
export const useChatSurprise = () => {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [partnerId, setPartnerId] = useState<string | null>(null);
  const [surprises, setSurprises] = useState<EngineSurprise[]>([]);
  const [eventStates, setEventStates] = useState<Record<string, Set<string>>>({});
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

  // ─── Fetch + realtime: the whole conversation's surprises, both directions ──
  const refreshSurprises = useCallback(async () => {
    if (!user || !partnerId) return;
    const rows = await fetchSurprisesForConversation(user.id, partnerId);
    setSurprises(rows);
    const states = await fetchSurpriseEventStates(rows.map((r) => r.id));
    setEventStates(states);
  }, [user, partnerId]);

  useEffect(() => {
    if (!user || !partnerId) return;
    refreshSurprises();
    const channel = supabase
      .channel("code-surprises-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "code_surprises" }, (payload) => {
        const creatorId = (payload.new as { creator_id?: string } | null)?.creator_id
          ?? (payload.old as { creator_id?: string } | null)?.creator_id;
        if (creatorId === partnerId || creatorId === user.id) refreshSurprises();
      })
      // Sender-side status pips (delivered/seen/opened) update live as the
      // recipient interacts, without the sender needing to reopen the chat.
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "code_surprise_events" }, () => {
        refreshSurprises();
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, partnerId, refreshSurprises]);

  const sessionStartRef = useRef(new Date().toISOString());

  const openSurprise = useCallback(
    async (s: EngineSurprise, opts: { fromDeepLink?: boolean } = {}) => {
      setSurprise(s);
      setVisible(true);
      const isMine = user?.id === s.creator_id;
      if (partnerId) {
        markReceived(partnerId, s.id);
        markSeen(partnerId, s.id);
      }
      // Only the recipient's open counts as a real "opened" lifecycle
      // event — the creator previewing their own sent surprise shouldn't
      // read to their partner as "they opened it".
      if (user && !isMine) {
        await recordSurpriseEvent(s.id, user.id, "received");
        await recordSurpriseEvent(s.id, user.id, "opened");
      }
      if (!opts.fromDeepLink && !isMine) {
        await registerView(s);
      }
    },
    [partnerId, user]
  );

  // Silent "delivered → received" progression, PLUS the direct auto-open.
  //
  // Phase 3 (§12) reasoning still applies below for why this fires from
  // one guarded spot keyed off created_at vs. session start rather than a
  // "first fetch" flag — that gating logic is unchanged.
  //
  // Reversed since: the previous pass here deliberately made surprises
  // wait for a tap ("a surprise's default state is a message sitting in
  // the timeline... it should never open itself"). Per explicit product
  // direction this is now the opposite — a genuinely NEW inbound surprise
  // opens straight into the overlay with no tap required at all. The row
  // still lands in the timeline first (that part of the redesign stands:
  // it's real chat history, not just a popup with no trace afterward) —
  // this only removes the requirement that someone tap it to see it. The
  // row remains tappable afterward purely to reopen/replay, same as
  // before.
  //
  // Gated to genuinely NEW arrivals only (created_at > session start), not
  // backlog — walking into a chat with 10 unopened surprises from last
  // week should not fire 10 overlays; those still wait for a tap, exactly
  // as they did before this change.
  useEffect(() => {
    if (!user || !partnerId) return;
    const receivedAlready = new Set(getReceivedIds(partnerId));
    for (const s of surprises) {
      if (s.creator_id !== user.id && !receivedAlready.has(s.id)) {
        markReceived(partnerId, s.id);
        if (s.created_at > sessionStartRef.current) {
          const mood = analyzeSurpriseContent(s.html_content, s.css_content, s.js_content).mood;
          // Staggered, not simultaneous — matches the brief's own example
          // timeline (receive's "soft rise" lands, THEN materialize's
          // "gentle impact" as the row visually pops in), rather than both
          // firing on the same instant and reading as one double-buzz.
          SurpriseHapticEngine.receive(mood);
          setTimeout(() => SurpriseHapticEngine.materialize(mood), 150);
          // Auto-open follows materialize by a further beat, so the
          // overlay's own entrance reads as growing out of the row that
          // just landed, rather than slamming in ahead of/on top of it.
          setTimeout(() => openSurprise(s), 500);
        }
      }
    }
  }, [surprises, user, partnerId, openSurprise]);

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

  const close = useCallback(() => {
    setVisible(false);
    if (surprise && user) recordSurpriseEvent(surprise.id, user.id, "finished");
    setTimeout(() => setSurprise(null), 400);
  }, [surprise, user]);

  // ─── Per-surprise lifecycle stage, for SurpriseMessage's status pips ────────
  const stageById = useMemo(() => {
    if (!user || !partnerId) return {} as Record<string, SurpriseStage>;
    const seen = new Set(getSeenIds(partnerId));
    const received = new Set(getReceivedIds(partnerId));
    const map: Record<string, SurpriseStage> = {};
    for (const s of surprises) {
      map[s.id] = deriveSurpriseStage({
        isMine: s.creator_id === user.id,
        events: eventStates[s.id],
        locallyReceived: received.has(s.id),
        locallySeen: seen.has(s.id),
        interacting: visible && surprise?.id === s.id,
        exhausted: s.views_used >= s.max_views,
      });
    }
    return map;
  }, [surprises, eventStates, user, partnerId, visible, surprise]);

  return { surprises, stageById, surprise, visible, openSurprise, close, partnerId };
};

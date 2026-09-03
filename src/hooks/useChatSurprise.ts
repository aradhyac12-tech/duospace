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
 * screen settled. That auto-takeover is gone — per the redesign brief, a
 * surprise's default state is a message sitting in the timeline, not a
 * popup, so it should never open itself. This now fetches the whole
 * conversation's surprises (both directions, like messages/call history
 * already do) so MessageTimeline can render one inline SurpriseMessage
 * per row; `openSurprise` remains for the one thing that SHOULD still
 * actively open the overlay: the person deliberately tapping a
 * SurpriseMessage, or a deep link.
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

  // Silent "delivered → received" progression: the moment an inbound
  // surprise is fetched at all, it counts as received — this is what
  // makes the inline message show up as delivered without the recipient
  // having to open anything. No overlay, no event write beyond the local
  // session marker (matches how "seen" already worked before this pass).
  //
  // Phase 3 (§12): this is also where SURPRISE_RECEIVE and
  // SURPRISE_MATERIALIZE both fire, together — for a genuine live arrival
  // the two are effectively simultaneous (the row materializes into the
  // timeline right as it's received), and firing them from this one
  // guarded spot means SurpriseMessage doesn't need its own fragile
  // "was I just born or am I backlog" heuristic.
  //
  // Gated by created_at vs. session start, NOT by "is this the first fetch"
  // — a load-order flag has a race (the initial mount effect can run once
  // with the still-empty [] state before the real fetch resolves, which
  // would wrongly flip an "already loaded" flag before any actual history
  // arrived) and can't tell "zero history, then a genuine first-ever live
  // surprise arrives 30s later" apart from "app just opened". Comparing
  // timestamps sidesteps both: a surprise created before this tab/session
  // began is backlog no matter when it happens to get fetched; one created
  // after is a live arrival no matter how many (zero or many) preceded it.
  const sessionStartRef = useRef(new Date().toISOString());
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
        }
      }
    }
  }, [surprises, user, partnerId]);

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

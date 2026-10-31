import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/appClient";
import { useAuth } from "@/hooks/useAuth";
import {
  EngineSurprise,
  ensureSurpriseBody,
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
import { SurpriseExperienceEngine } from "@/lib/surpriseExperienceEngine";
import {
  fetchCoupleSyncEvents,
  sendPartnerReaction,
  feelPartnerReaction,
  feelPartnerInteraction,
  eventTypeToReactionKind,
  flushCoupleSyncOutbox,
  computeDualActivation,
  type CoupleSyncEventRow,
  type DualActivationState,
} from "@/lib/coupleSync";
import { uniqueChannelName } from "@/lib/realtimeChannel";

// Cheap change-detection signatures: a refresh that returns identical data must
// not replace state (a new array/object identity re-renders the whole chat).
const surprisesSig = (rows: EngineSurprise[]) =>
  rows
    .map((r) => `${r.id}|${r.views_used}|${r.max_views}|${(r as { is_active?: boolean }).is_active ?? ""}|${r.partner_reactions_enabled ?? ""}|${r.title}|${r.created_at}`)
    .join("~");
const eventStatesSig = (m: Record<string, Set<string>>) =>
  Object.keys(m).sort().map((k) => `${k}:${[...m[k]].sort().join(",")}`).join("~");
const dualSig = (m: Record<string, DualActivationState>) =>
  Object.keys(m).sort().map((k) => `${k}:${+m[k].mine}${+m[k].partner}${+m[k].both}`).join("~");

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
  // §7: per-surprise "have I / has my partner tapped their half" state for
  // dual-activation templates (Two-Screen Heart). Keyed by surprise id,
  // computed fresh from the same coupleSyncRows fetch below — not a
  // separate query.
  const [dualActivationById, setDualActivationById] = useState<Record<string, DualActivationState>>({});
  // §8 (Living Photograph): bumped once per fresh surprise_interacted
  // event for one of MY surprises — SurpriseReveal watches its own
  // surprise's counter and posts a one-shot ripple into the frame when it
  // changes. A plain incrementing counter, not the event's own timestamp —
  // CodeSurpriseFrame only cares THAT it changed, not by how much.
  const [partnerRippleById, setPartnerRippleById] = useState<Record<string, number>>({});
  const [surprise, setSurprise] = useState<EngineSurprise | null>(null);
  const [visible, setVisible] = useState(false);
  const deepLinkHandled = useRef(false);
  // Pending "unmount the overlay after its exit animation" timer; cancelled when another surprise opens first.
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const sessionStartRef = useRef(new Date().toISOString());

  // §12/§15: Couple Sync — which partner-authored events this device has
  // already felt, so a re-fetch (realtime tick, reconnect, plain remount)
  // never plays the same reaction pulse twice. Session-scoped like
  // markReceived/markSeen above, same reasoning: this is a "have I already
  // reacted to this" cache, not a source of truth (the server's UNIQUE
  // constraint is that) — losing it just means, at worst, a refresh across
  // browser sessions could re-feel one pulse, which is harmless and far
  // better than the alternative of silently eating a real duplicate guard.
  const feltKeyFor = (partnerId: string) => `felt-couple-sync:${partnerId}`;
  const getFeltKeys = (pid: string): string[] => {
    try { return JSON.parse(sessionStorage.getItem(feltKeyFor(pid)) || "[]"); } catch { return []; }
  };
  const markFelt = (pid: string, key: string) => {
    const felt = getFeltKeys(pid);
    if (!felt.includes(key)) sessionStorage.setItem(feltKeyFor(pid), JSON.stringify([...felt, key]));
  };

  /** Diffs freshly-fetched Couple Sync rows against what this device has
   *  already felt, and plays the local haptic for anything new that's
   *  ABOUT one of my own surprises and was done BY my partner (not my own
   *  action echoing back through the same query). Covers both the live
   *  realtime path and reconnecting after being offline when it happened —
   *  §15: "a surprise must still work if... partner goes offline... realtime
   *  reconnects" — the row is just sitting there waiting either way. */
  const processCoupleSyncEvents = useCallback((rows: CoupleSyncEventRow[], mySurpriseIds: Set<string>) => {
    if (!user || !partnerId) return;
    for (const row of rows) {
      if (row.user_id === user.id) continue; // my own action, not a partner reaction to feel
      if (!mySurpriseIds.has(row.surprise_id)) continue; // not my surprise — not mine to feel
      const key = `${row.surprise_id}:${row.user_id}:${row.event_type}`;
      if (getFeltKeys(partnerId).includes(key)) continue;
      markFelt(partnerId, key);
      const kind = eventTypeToReactionKind(row.event_type);
      if (kind) {
        feelPartnerReaction(kind);
      } else if (row.event_type === "surprise_interacted") {
        // §6: "PARTNER_B interacts → PARTNER_A receives subtle response" —
        // the one piece of that worked example with no felt half until now.
        feelPartnerInteraction();
        // §8: also give any currently-open Living Photograph (or future
        // template) a live visual signal to react to, not just the haptic.
        setPartnerRippleById((prev) => ({ ...prev, [row.surprise_id]: (prev[row.surprise_id] ?? 0) + 1 }));
      }
      // surprise_major_reveal still has no local felt-pulse of its own —
      // it's recorded so a future Two-Screen Heart preset (§9/§11) has the
      // persisted state to build its dual-synchronization payoff on.
    }
  }, [user, partnerId]);

  // PERF/FREEZE FIX: opening one surprise writes several rows in a burst
  // (received, opened, views_used, a partner reaction, finished...) and every
  // one of them used to fire its own refresh -- 3 sequential queries each,
  // overlapping, answering out of order, and each one replacing
  // surprises/eventStates/dualActivation with brand-new objects. That rebuilt
  // the ENTIRE chat timeline (and, in long chats, remounted every virtual
  // row's ResizeObserver) several times in the exact second the surprise
  // overlay was animating in. Now: one refresh in flight at a time, further
  // requests collapse into a single trailing run, and state is only replaced
  // when the data actually changed.
  const refreshInFlight = useRef(false);
  const refreshQueued = useRef(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true; // re-arm after a StrictMode dev remount
    return () => {
      aliveRef.current = false;
      if (refreshTimer.current) { clearTimeout(refreshTimer.current); refreshTimer.current = null; }
    };
  }, []);

  const runRefresh = useCallback(async () => {
    if (!user || !partnerId) return;
    const rows = await fetchSurprisesForConversation(user.id, partnerId);
    if (!aliveRef.current) return;
    const nextSig = surprisesSig(rows);
    setSurprises((prev) => (surprisesSig(prev) === nextSig ? prev : rows));
    const states = await fetchSurpriseEventStates(rows.map((r) => r.id));
    if (!aliveRef.current) return;
    const stSig = eventStatesSig(states);
    setEventStates((prev) => (eventStatesSig(prev) === stSig ? prev : states));
    // §15: cheap no-op when the outbox is empty; catches "was offline when
    // MAJOR_REVEAL/a reaction was sent, back online now" without needing
    // its own separate effect/listener per screen.
    void flushCoupleSyncOutbox();
    if (rows.length > 0) {
      const coupleSyncRows = await fetchCoupleSyncEvents(rows.map((r) => r.id));
      if (!aliveRef.current) return;
      // Felt-reaction pulses: still only for surprises I created (I'm the
      // one who should feel a reaction about something I sent).
      const mySurpriseIds = new Set(rows.filter((r) => r.creator_id === user.id).map((r) => r.id));
      if (mySurpriseIds.size > 0) processCoupleSyncEvents(coupleSyncRows, mySurpriseIds);
      // Dual-activation state: computed for EVERY surprise regardless of
      // creator -- both participants need this symmetrically (see the RLS
      // migration 20260928140000_surprise_couple_sync_symmetric_visibility).
      const nextDual: Record<string, DualActivationState> = {};
      for (const r of rows) nextDual[r.id] = computeDualActivation(coupleSyncRows, r.id, user.id, partnerId);
      const dSig = dualSig(nextDual);
      setDualActivationById((prev) => (dualSig(prev) === dSig ? prev : nextDual));
    }
  }, [user, partnerId, processCoupleSyncEvents]);

  const refreshSurprises = useCallback(async () => {
    if (refreshInFlight.current) { refreshQueued.current = true; return; }
    refreshInFlight.current = true;
    try {
      await runRefresh();
    } catch (err) {
      console.warn("[surprise] refresh failed", err);
    } finally {
      refreshInFlight.current = false;
      if (refreshQueued.current && aliveRef.current) {
        refreshQueued.current = false;
        void refreshSurprises();
      }
    }
  }, [runRefresh]);

  /** Realtime path: a burst of events becomes one refresh ~200ms later. */
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      void refreshSurprises();
    }, 200);
  }, [refreshSurprises]);

  useEffect(() => {
    if (!user || !partnerId) return;
    refreshSurprises();
    const channel = supabase
      .channel(uniqueChannelName("code-surprises-realtime"))
      .on("postgres_changes", { event: "*", schema: "public", table: "code_surprises" }, (payload) => {
        const creatorId = (payload.new as { creator_id?: string } | null)?.creator_id
          ?? (payload.old as { creator_id?: string } | null)?.creator_id;
        // creatorId can be missing when Realtime drops an oversized row's
        // columns from the payload (imported surprises embed media) — the
        // list refresh is cheap now (metadata only), so refresh then too.
        if (creatorId === undefined || creatorId === partnerId || creatorId === user.id) scheduleRefresh();
      })
      // Sender-side status pips (delivered/seen/opened) update live as the
      // recipient interacts, without the sender needing to reopen the chat.
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "code_surprise_events" }, () => {
        scheduleRefresh();
      })
      // §7: Couple Sync's own event stream — a full refreshSurprises() on
      // every row (rather than reading payload.new directly) keeps this on
      // the exact same idempotent, "diff against what I've already felt"
      // path refreshSurprises already runs on mount/reconnect, instead of
      // a second parallel felt-check living only in the realtime handler.
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "surprise_couple_sync_events" }, () => {
        scheduleRefresh();
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, partnerId, refreshSurprises, scheduleRefresh]);

  const openSurprise = useCallback(
    async (listRow: EngineSurprise, opts: { fromDeepLink?: boolean } = {}) => {
      // List rows are slim (no html/css/js) — pull the body once, here.
      const s = await ensureSurpriseBody(listRow);
      if (!s) return; // deleted / no longer visible
      if (clearTimerRef.current) { clearTimeout(clearTimerRef.current); clearTimerRef.current = null; }
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
        // §8: partner reaction — this is the recipient's device, so this
        // is exactly the "recipient opens a surprise" moment the sender
        // should optionally feel. Gated by the surprise's own creator
        // setting inside sendPartnerReaction itself.
        void sendPartnerReaction(s, user.id, "opened");
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
          void (async () => {
            // Slim list row → fetch the body first: the surprise's own
            // Haptic DNA (mood + deterministic seed) is derived from its
            // actual code, via SurpriseExperienceEngine — see §1/§2.
            const full = await ensureSurpriseBody(s);
            if (!full) return;
            // Staggered, not simultaneous — matches the brief's own example
            // timeline (receive's "soft rise" lands, THEN materialize's
            // "gentle impact" as the row visually pops in), rather than both
            // firing on the same instant and reading as one double-buzz.
            SurpriseExperienceEngine.dispatch(full.id, "RECEIVE", full);
            setTimeout(() => SurpriseExperienceEngine.dispatch(full.id, "MATERIALIZE", full), 150);
            // Auto-open follows materialize by a further beat, so the
            // overlay's own entrance reads as growing out of the row that
            // just landed, rather than slamming in ahead of/on top of it.
            setTimeout(() => openSurprise(full), 500);
          })();
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

  const close = useCallback((engaged = false) => {
    setVisible(false);
    if (surprise && user) {
      recordSurpriseEvent(surprise.id, user.id, "finished");
      // §8: "Completed" reaction only for genuine engagement (matches the
      // local COMPLETE-vs-CLOSE haptic split in SurpriseReveal's doClose) —
      // an instant bail shouldn't read to the sender as "they finished it".
      // Same isMine gate as openSurprise's "opened" reaction above.
      if (engaged && surprise.creator_id !== user.id) void sendPartnerReaction(surprise, user.id, "completed");
    }
    // Drop this surprise's cached DNA/fired-state now that its overlay is
    // gone — see SurpriseExperienceEngine.release(). Reopening the same
    // surprise later regenerates identical DNA (deterministic on id), so
    // nothing is lost by releasing eagerly here.
    if (surprise) SurpriseExperienceEngine.release(surprise.id);
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    const closingId = surprise?.id;
    clearTimerRef.current = setTimeout(() => {
      clearTimerRef.current = null;
      // Only clear if nothing else was opened during the 400ms exit.
      setSurprise((cur) => (cur && cur.id === closingId ? null : cur));
    }, 400);
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

  return { surprises, stageById, surprise, visible, openSurprise, close, partnerId, dualActivationById, partnerRippleById };
};

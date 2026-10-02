/**
 * Surprise 3.0 §7 (Couple Sync), §8 (Partner Reaction), §12 (Two-Screen
 * Heart safety), §15 (offline/reconnect).
 *
 * NOT frame-perfect synchronization between two phones — semantic events
 * only, persisted server-side via surprise_couple_sync_events (see its
 * migration for why that's a separate table from code_surprise_events).
 * Each device receives a semantic TYPE ("partner_reaction_opened") and
 * decides its own local haptic/visual response — never a raw haptic
 * command crossing the wire, per §7.
 */
import { supabase } from "@/integrations/supabase/appClient";
import type { EngineSurprise } from "@/lib/surpriseEngine";
import type { HapticKind } from "@/lib/haptics";
import { playCapabilityAwareSequence } from "@/lib/surpriseCapabilities";
import type { HapticSequence } from "@/lib/surpriseHaptics";

export type CoupleSyncEventType =
  | "surprise_major_reveal"
  | "surprise_interacted"
  | "surprise_dual_activated"
  | "partner_reaction_opened"
  | "partner_reaction_completed"
  | "partner_reaction_heart";

export type PartnerReactionKind = "opened" | "completed" | "heart";

const REACTION_TO_EVENT: Record<PartnerReactionKind, CoupleSyncEventType> = {
  opened: "partner_reaction_opened",
  completed: "partner_reaction_completed",
  heart: "partner_reaction_heart",
};

// ─── Sending: exactly-once insert, with a local offline outbox ─────────────

const OUTBOX_KEY = "surprise-couple-sync-outbox";

interface OutboxEntry {
  surpriseId: string;
  userId: string;
  eventType: CoupleSyncEventType;
}

const readOutbox = (): OutboxEntry[] => {
  try {
    return JSON.parse(localStorage.getItem(OUTBOX_KEY) || "[]");
  } catch {
    return [];
  }
};

const writeOutbox = (entries: OutboxEntry[]) => {
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(entries));
  } catch {
    // storage full/unavailable — the event is still lost only for THIS
    // offline window; nothing else in the app depends on the outbox.
  }
};

const enqueueOutbox = (entry: OutboxEntry) => {
  const current = readOutbox();
  const dupe = current.some((e) => e.surpriseId === entry.surpriseId && e.userId === entry.userId && e.eventType === entry.eventType);
  if (!dupe) writeOutbox([...current, entry]);
};

const insertCoupleSyncEvent = async (entry: OutboxEntry): Promise<boolean> => {
  // ignoreDuplicates: true against the table's real UNIQUE(surprise_id,
  // user_id, event_type) constraint — a duplicate dispatch (remount,
  // reconnect replay, a retried outbox entry) becomes a harmless no-op
  // instead of a second row / a thrown 23505. This is the "idempotent
  // event IDs" / "avoid duplicate events" requirement from §12, enforced
  // server-side so it holds even across two different devices/tabs, not
  // just within one client's own session state.
  const { error } = await supabase.from("surprise_couple_sync_events").upsert(
    { surprise_id: entry.surpriseId, user_id: entry.userId, event_type: entry.eventType } as any,
    { onConflict: "surprise_id,user_id,event_type", ignoreDuplicates: true }
  );
  return !error;
};

/**
 * Records one Couple Sync semantic event. On failure (offline, most
 * commonly) queues it in the local outbox rather than dropping it — §15:
 * "a surprise must still work if network disappears after opening" /
 * §12: "if the partner is offline, queue the semantic event and replay...
 * when they return" covers the RECEIVING side (the row is just there
 * whenever they next fetch); this covers the SENDING side, where the
 * insert itself needs the network and may not have it yet.
 */
export const recordCoupleSyncEvent = async (
  surpriseId: string,
  userId: string,
  eventType: CoupleSyncEventType
): Promise<void> => {
  const entry: OutboxEntry = { surpriseId, userId, eventType };
  const ok = await insertCoupleSyncEvent(entry).catch(() => false);
  if (!ok) enqueueOutbox(entry);
};

/** Retries every queued outbox entry — call on reconnect (a `online`
 *  listener) and on app foreground. Entries that still fail stay queued;
 *  entries that succeed (including ones that turn out to already exist
 *  server-side, thanks to ignoreDuplicates) are dropped from the outbox. */
export const flushCoupleSyncOutbox = async (): Promise<void> => {
  const pending = readOutbox();
  if (pending.length === 0) return;
  const stillPending: OutboxEntry[] = [];
  for (const entry of pending) {
    const ok = await insertCoupleSyncEvent(entry).catch(() => false);
    if (!ok) stillPending.push(entry);
  }
  writeOutbox(stillPending);
};

if (typeof window !== "undefined") {
  window.addEventListener("online", () => { void flushCoupleSyncOutbox(); });
}

/** §8: creator-gated. Called from the RECIPIENT's device (they're the one
 *  whose action — opening/completing — produces the reaction), checking
 *  the SENDER's own stored preference for their surprise before emitting
 *  anything. */
export const sendPartnerReaction = async (
  surprise: Pick<EngineSurprise, "id" | "partner_reactions_enabled" | "sensory_settings">,
  userId: string,
  kind: PartnerReactionKind
): Promise<void> => {
  if (surprise.partner_reactions_enabled === false) return;
  // §2 audit fix: the Sensory Director's Partner Reaction mode
  // (off/on_receive/on_open/on_complete) was persisted from the editor but
  // never actually read anywhere — wired here. "heart" stays ungated by
  // this: it's always a manual, user-initiated send, distinct from the
  // automatic opened/completed reactions this mode actually governs.
  // Undefined (Auto, and every surprise created before this fix) keeps
  // today's existing behavior: both opened and completed fire.
  // on_receive/on_open are treated as the same trigger point on purpose —
  // the app has one recipient-open signal, not a separate delivered-vs-
  // opened one, so pretending they're different would be exactly the kind
  // of UI-implies-a-feature-that-isn't-there gap this phase calls out.
  const mode = surprise.sensory_settings?.partnerReaction;
  if (kind !== "heart" && mode && mode !== "custom") {
    const allowed = mode === "off" ? false : mode === "on_complete" ? kind === "completed" : kind === "opened";
    if (!allowed) return;
  }
  await recordCoupleSyncEvent(surprise.id, userId, REACTION_TO_EVENT[kind]);
};

/**
 * §6's own worked example: "PARTNER_B interacts → semantic response →
 * PARTNER_A receives subtle response" — this was the one piece of that
 * example with no wiring at all: SurpriseExperienceEngine's local INTERACT
 * dispatch never reached Couple Sync. Deliberately fires at most ONCE per
 * (surprise, user) rather than on every tap — the table's own UNIQUE
 * constraint makes repeat calls harmless no-ops, so no separate
 * client-side throttle is needed. This is a single "they're engaging with
 * it" signal, not a live ripple-per-tap stream — a repeatable version
 * would need a non-unique-constrained event shape, which is more than
 * this signal needs (§17: do not overbuild).
 */
export const recordInteraction = async (
  surprise: Pick<EngineSurprise, "id" | "partner_reactions_enabled">,
  userId: string
): Promise<void> => {
  if (surprise.partner_reactions_enabled === false) return;
  await recordCoupleSyncEvent(surprise.id, userId, "surprise_interacted");
};

/**
 * §7: Two-Screen Heart (and any future dual-activation template) — generic
 * "I've done my half" signal, NOT gated by partner_reactions_enabled. That
 * setting is for optional notification-style reactions; this is core
 * gameplay state for a surprise whose content requires both people to act,
 * so it always records regardless of that preference. Exactly-once per
 * (surprise, user) via the same UNIQUE constraint every other Couple Sync
 * event uses — a duplicate call (re-tap, remount, reconnect) is a no-op.
 */
export const recordDualActivation = async (surpriseId: string, userId: string): Promise<void> => {
  await recordCoupleSyncEvent(surpriseId, userId, "surprise_dual_activated");
};

export interface DualActivationState {
  mine: boolean;
  partner: boolean;
  both: boolean;
}

/**
 * Derives "have I activated / has my partner activated / have both" for one
 * surprise from the SAME rows useChatSurprise already fetches each refresh
 * — no separate query. Pure and synchronous on purpose: called on every
 * refresh, from data already in memory.
 */
export const computeDualActivation = (
  rows: CoupleSyncEventRow[],
  surpriseId: string,
  userId: string,
  partnerId: string
): DualActivationState => {
  let mine = false, partner = false;
  for (const row of rows) {
    if (row.surprise_id !== surpriseId || row.event_type !== "surprise_dual_activated") continue;
    if (row.user_id === userId) mine = true;
    else if (row.user_id === partnerId) partner = true;
  }
  return { mine, partner, both: mine && partner };
};

// ─── Receiving: batched fetch, mirroring fetchSurpriseEventStates ──────────

export interface CoupleSyncEventRow {
  surprise_id: string;
  user_id: string;
  event_type: CoupleSyncEventType;
  created_at: string;
}

/** One query for every Couple Sync event on this conversation's surprises —
 *  same batching reasoning as fetchSurpriseEventStates (one round trip for
 *  N surprises, not N queries). */
export const fetchCoupleSyncEvents = async (surpriseIds: string[]): Promise<CoupleSyncEventRow[]> => {
  if (surpriseIds.length === 0) return [];
  const { data, error } = await supabase
    .from("surprise_couple_sync_events")
    .select("surprise_id,user_id,event_type,created_at")
    .in("surprise_id", surpriseIds);
  if (error || !data) return [];
  return data as CoupleSyncEventRow[];
};

// ─── Feeling it: partner-reaction haptics ──────────────────────────────────

const TICK: HapticKind = "tick";
const LIGHT: HapticKind = "light";
const MEDIUM: HapticKind = "medium";
const DOUBLE: HapticKind = "double";

/**
 * Deliberately NOT run through a surprise's own Haptic DNA (§2) — a
 * partner reaction is meant to feel like a consistent, recognizable
 * "the two phones are connected" language regardless of which surprise
 * triggered it (§8: "should feel like the two phones are connected" /
 * "do not make this notification-like or intrusive"), not vary by mood
 * the way the surprise's own open/climax beats do.
 */
export const partnerReactionHapticSequence = (kind: PartnerReactionKind): HapticSequence => {
  switch (kind) {
    // "Opened": tiny confirmation pulse.
    case "opened": return [{ kind: TICK, delayMs: 0 }];
    // "Completed": soft double pulse.
    case "completed": return [{ kind: LIGHT, delayMs: 0 }, { kind: DOUBLE, delayMs: 140 }];
    // "Heart reaction": heartbeat pulse (lub-dub), same shape as the
    // heartbeat rhythm concept in §2 but fixed rather than DNA-derived.
    case "heart": return [{ kind: MEDIUM, delayMs: 0 }, { kind: LIGHT, delayMs: 140 }];
  }
};

/** Fires the local felt half of a partner reaction. Callers are
 *  responsible for having already confirmed this event is new (not
 *  something this device already reacted to) and belongs to a surprise
 *  this user actually created — see useChatSurprise's session-tracked
 *  "already felt" set, mirroring markReceived/markSeen. */
export const feelPartnerReaction = (kind: PartnerReactionKind): void => {
  playCapabilityAwareSequence(partnerReactionHapticSequence(kind));
};

/**
 * Fires the local felt pulse for a partner actively interacting with a
 * surprise you sent — deliberately the lightest sequence of all of these
 * (a single soft tap, no second beat), so it reads as ambient "they're
 * there" awareness rather than a notification demanding attention.
 */
export const feelPartnerInteraction = (): void => {
  playCapabilityAwareSequence([{ kind: "soft", delayMs: 0 }]);
};

export const eventTypeToReactionKind = (eventType: CoupleSyncEventType): PartnerReactionKind | null => {
  switch (eventType) {
    case "partner_reaction_opened": return "opened";
    case "partner_reaction_completed": return "completed";
    case "partner_reaction_heart": return "heart";
    default: return null;
  }
};

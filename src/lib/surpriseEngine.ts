import { supabase } from "@/integrations/supabase/appClient";

export interface EngineSurprise {
  id: string;
  title: string;
  html_content: string;
  css_content: string;
  js_content: string;
  max_views: number;
  views_used: number;
  creator_id: string;
  created_at: string;
  /** §8: creator-controlled opt-out for Couple Sync partner reactions.
   *  Column default is true; optional here too so slim/legacy rows that
   *  predate the migration still type-check as "reactions on". */
  partner_reactions_enabled?: boolean;
  /** §10: creator's Sensory Director overrides, or null/undefined for
   *  fully-Auto (deterministic DNA, untouched) — see lib/surpriseSensory.ts. */
  sensory_settings?: import("@/lib/surpriseSensory").SensorySettings | null;
  /**
   * false on the slim rows fetchSurprisesForConversation() returns (html/
   * css/js are "" there). Imported surprises can embed megabytes of media,
   * and the conversation list is re-fetched on every realtime event — so the
   * list carries metadata only and the body is fetched once, on open, via
   * ensureSurpriseBody(). undefined/true = the body is present.
   */
  body_loaded?: boolean;
}

/**
 * Random-but-bounded entry delay so the reveal never feels mechanical.
 * "3 5 seconds" -> 3200ms - 4800ms after the chat screen has settled.
 */
export const pickEntryDelayMs = () => 3200 + Math.floor(Math.random() * 1600);

/**
 * Deterministic per-surprise variant so the SAME surprise always renders the
 * same way for both people, while different surprises still feel distinct.
 * This is what lets "glass blend" vs "full takeover" and "css depth" vs
 * "webgl scene" both exist in the system without needing a schema change —
 * the engine picks, consistently, per surprise id.
 */
export const surpriseVariant = (id: string) => {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return {
    richScene: hash % 3 !== 0, // ~2/3 of surprises earn the deeper WebGL layer once expanded
    seed: hash,
  };
};

const SURPRISE_COLUMNS =
  "id,creator_id,title,html_content,css_content,js_content,is_active,max_views,views_used,created_at,partner_reactions_enabled,sensory_settings";
// Everything except the (possibly multi-MB) code — see body_loaded above.
const SURPRISE_META_COLUMNS = "id,creator_id,title,is_active,max_views,views_used,created_at,partner_reactions_enabled,sensory_settings";

// Column set for a Supabase project that hasn't run
// supabase/migrations/20260926090000_surprise_couple_sync.sql and
// 20260926100000_surprise_sensory_director.sql yet — both are additive
// (ADD COLUMN IF NOT EXISTS) and safe to run any time; this fallback is a
// stopgap for the gap between "code deployed" and "migration applied", not
// a substitute for actually running them.
const LEGACY_SURPRISE_COLUMNS =
  "id,creator_id,title,html_content,css_content,js_content,is_active,max_views,views_used,created_at";
const LEGACY_SURPRISE_META_COLUMNS = "id,creator_id,title,is_active,max_views,views_used,created_at";
export { LEGACY_SURPRISE_COLUMNS };

/** true once we've confirmed the migration IS applied (skip the fallback
 *  dance from then on); false once we've confirmed it ISN'T (skip straight
 *  to legacy columns instead of re-failing the full query every time);
 *  null = not yet known this session. */
let hasSensoryColumns: boolean | null = null;

export const isMissingColumnError = (error: { code?: string; message?: string } | null | undefined): boolean =>
  !!error && (error.code === "42703" || /column .* does not exist/i.test(error.message ?? ""));
/**
 * Runs a code_surprises select that wants the post-migration columns
 * (partner_reactions_enabled, sensory_settings), and transparently falls
 * back to the pre-migration column set if the database doesn't have them
 * yet (42703/undefined_column) — rather than the whole surprises list
 * failing to load. Rows fetched this way simply lack those two optional
 * EngineSurprise fields; every call site already treats them as optional
 * with safe defaults (`?? true`, `?? {}`, `!== false`), so nothing else
 * needs to change for this to degrade cleanly.
 *
 * `full`/`legacy` are the two column strings for THIS query's shape (list
 * vs. single-row queries select different column sets); `run` executes the
 * query for a given column string.
 */
const selectSurprisesResilient = async <T,>(
  full: string,
  legacy: string,
  run: (columns: string) => PromiseLike<{ data: T | null; error: { code?: string; message?: string } | null }>
): Promise<{ data: T | null; error: { code?: string; message?: string } | null }> => {
  if (hasSensoryColumns === false) return run(legacy);
  const result = await run(full);
  if (result.error && isMissingColumnError(result.error)) {
    hasSensoryColumns = false;
    return run(legacy);
  }
  if (!result.error) hasSensoryColumns = true;
  return result;
};

// No longer called by useChatSurprise (superseded by
// fetchSurprisesForConversation below, which needs to see both directions
// for the inline timeline). Left in place — single-surprise "next unseen
// from partner" lookup is still a reasonable primitive if anything else
// needs it later — but nothing in the app currently calls it.
export const fetchLatestSurpriseFromPartner = async (partnerId: string, seenIds: string[]) => {
  const { data, error } = await selectSurprisesResilient(SURPRISE_COLUMNS, LEGACY_SURPRISE_COLUMNS, (columns) =>
    supabase
      .from("code_surprises")
      .select(columns)
      .eq("creator_id", partnerId)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(5)
  );

  if (error || !(data as EngineSurprise[] | null)?.length) return null;

  const next = (data as EngineSurprise[]).find(
    (s) => s.views_used < s.max_views && !seenIds.includes(s.id)
  );

  return next ?? null;
};

/** Deep-link resolution: fetch a specific surprise by id regardless of "seen" state. */
export const fetchSurpriseById = async (id: string) => {
  const { data, error } = await selectSurprisesResilient(SURPRISE_COLUMNS, LEGACY_SURPRISE_COLUMNS, (columns) =>
    supabase.from("code_surprises").select(columns).eq("id", id).maybeSingle()
  );

  if (error || !data) return null;
  return { ...(data as EngineSurprise), body_loaded: true };
};

/**
 * Slim list rows → full surprise. No-op (no network) when the body is
 * already there, so it is always safe to call before opening one.
 */
export const ensureSurpriseBody = async (s: EngineSurprise): Promise<EngineSurprise | null> => {
  if (s.body_loaded !== false) return s;
  return fetchSurpriseById(s.id);
};

/**
 * Everything either partner has created in this pair's history, both
 * directions — this is what lets a sent surprise sit in the timeline for
 * BOTH people (recipient sees it inbound and openable; sender sees it
 * outbound with delivery/seen/opened status), matching how `messages` and
 * `call_history` are already fetched for the whole conversation rather than
 * "just what I received". Superset of fetchLatestSurpriseFromPartner above,
 * which stays as-is since the deep-link/legacy-poll paths still use it.
 */
export const fetchSurprisesForConversation = async (
  userId: string,
  partnerId: string,
  limit = 100
) => {
  const { data, error } = await selectSurprisesResilient(SURPRISE_META_COLUMNS, LEGACY_SURPRISE_META_COLUMNS, (columns) =>
    supabase
      .from("code_surprises")
      .select(columns)
      .in("creator_id", [userId, partnerId])
      .order("created_at", { ascending: true })
      .limit(limit)
  );

  if (error || !data) return [];
  return (data as Omit<EngineSurprise, "html_content" | "css_content" | "js_content">[]).map((row) => ({
    ...row,
    html_content: "",
    css_content: "",
    js_content: "",
    body_loaded: false,
  }));
};

export const seenKeyFor = (partnerId: string) => `seen-surprises:${partnerId}`;

export const getSeenIds = (partnerId: string): string[] => {
  try {
    return JSON.parse(sessionStorage.getItem(seenKeyFor(partnerId)) || "[]");
  } catch {
    return [];
  }
};

export const markSeen = (partnerId: string, id: string) => {
  const seen = getSeenIds(partnerId);
  if (!seen.includes(id)) {
    sessionStorage.setItem(seenKeyFor(partnerId), JSON.stringify([...seen, id]));
  }
};

// Separate from "seen" above: "received" fires the moment a surprise is
// fetched and appears in the timeline at all (matching the state machine's
// created→sent→delivered→received progression, which happens on arrival,
// not on open) — "seen"/"opened" only fire once the person actually taps
// it. Tracked the same session-local way so we don't write a DB event row
// on every single fetch/refresh for a surprise we've already logged once.
const receivedKeyFor = (partnerId: string) => `received-surprises:${partnerId}`;

export const getReceivedIds = (partnerId: string): string[] => {
  try {
    return JSON.parse(sessionStorage.getItem(receivedKeyFor(partnerId)) || "[]");
  } catch {
    return [];
  }
};

export const markReceived = (partnerId: string, id: string) => {
  const received = getReceivedIds(partnerId);
  if (!received.includes(id)) {
    sessionStorage.setItem(receivedKeyFor(partnerId), JSON.stringify([...received, id]));
  }
};

export const recordSurpriseEvent = async (
  surpriseId: string,
  userId: string,
  eventType: "received" | "opened" | "expanded" | "finished"
) => {
  await supabase.from("code_surprise_events").insert({
    surprise_id: surpriseId,
    user_id: userId,
    event_type: eventType,
  } as any);
};

export const registerView = async (surprise: EngineSurprise) => {
  const nextViews = surprise.views_used + 1;
  await supabase
    .from("code_surprises")
    .update({ views_used: nextViews, is_active: nextViews < surprise.max_views } as any)
    .eq("id", surprise.id);
};

/**
 * One query for every surprise's event history in this conversation, keyed
 * by surprise id -> the set of event_types recorded for it (by anyone —
 * for the state machine we only care THAT "opened" happened, not who did
 * it, since only the recipient ever legitimately opens a partner's
 * surprise). Batched like this (not one query per SurpriseMessage) so
 * rendering N surprises in a timeline costs one round trip, not N.
 */
export const fetchSurpriseEventStates = async (
  surpriseIds: string[]
): Promise<Record<string, Set<string>>> => {
  if (surpriseIds.length === 0) return {};
  const { data, error } = await supabase
    .from("code_surprise_events")
    .select("surprise_id,event_type")
    .in("surprise_id", surpriseIds);

  if (error || !data) return {};
  const map: Record<string, Set<string>> = {};
  for (const row of data as { surprise_id: string; event_type: string }[]) {
    if (!map[row.surprise_id]) map[row.surprise_id] = new Set();
    map[row.surprise_id].add(row.event_type);
  }
  return map;
};

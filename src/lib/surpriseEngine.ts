import { supabase } from "@/integrations/supabase/client";

export interface EngineSurprise {
  id: string;
  title: string;
  html_content: string;
  css_content: string;
  js_content: string;
  max_views: number;
  views_used: number;
  creator_id: string;
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
  "id,creator_id,title,html_content,css_content,js_content,is_active,max_views,views_used,created_at";

export const fetchLatestSurpriseFromPartner = async (partnerId: string, seenIds: string[]) => {
  const { data, error } = await supabase
    .from("code_surprises")
    .select(SURPRISE_COLUMNS)
    .eq("creator_id", partnerId)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(5);

  if (error || !data?.length) return null;

  const next = (data as EngineSurprise[]).find(
    (s) => s.views_used < s.max_views && !seenIds.includes(s.id)
  );

  return next ?? null;
};

/** Deep-link resolution: fetch a specific surprise by id regardless of "seen" state. */
export const fetchSurpriseById = async (id: string) => {
  const { data, error } = await supabase
    .from("code_surprises")
    .select(SURPRISE_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error || !data) return null;
  return data as EngineSurprise;
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

/**
 * Mirrors the active account's listening profile (play log + recent-plays
 * window, see playHistory.ts) to Supabase `music_profiles`, one row per
 * user (RLS: own row only). Local storage stays the source the player reads
 * synchronously; this just makes it follow the ACCOUNT instead of the phone.
 *
 *   start(userId): pull remote → merge into local → push merged back, then
 *                  push (debounced) after every local change.
 *   stop():        flush any pending push for the old account, detach.
 *
 * Best effort by design: offline / table missing / RLS error never affects
 * playback — the local profile keeps working and the next change retries.
 */
import { supabase } from "@/integrations/supabase/appClient";
import { exportMusicProfile, importMusicProfile, setMusicProfileScope, subscribeProfileChange } from "./playHistory";

const PUSH_DEBOUNCE_MS = 8_000;

let activeUser: string | null = null;
let unsubscribe: (() => void) | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;

async function push(userId: string): Promise<void> {
  dirty = false;
  const p = exportMusicProfile();
  const { error } = await supabase.from("music_profiles").upsert(
    { user_id: userId, play_log: p.playLog, play_history: p.playHistory, prefs: p.prefs ?? {}, updated_at: new Date().toISOString() },
    { onConflict: "user_id" },
  );
  if (error) dirty = true; // retry on the next change / next start
}

function flush(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  if (activeUser && dirty) void push(activeUser).catch(() => { dirty = true; });
}

export async function startMusicProfileSync(userId: string): Promise<void> {
  stopMusicProfileSync();
  setMusicProfileScope(userId);
  activeUser = userId;
  unsubscribe = subscribeProfileChange(() => {
    dirty = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; flush(); }, PUSH_DEBOUNCE_MS);
  });
  try {
    const { data, error } = await supabase.from("music_profiles").select("play_log, play_history, prefs").eq("user_id", userId).maybeSingle();
    if (activeUser !== userId) return; // account switched while the request was in flight
    if (error) return;
    const merged = importMusicProfile(data ? { playLog: data.play_log, playHistory: data.play_history, prefs: data.prefs } : null);
    const remoteLen = data && Array.isArray(data.play_log) ? data.play_log.length : 0;
    if (!data || merged.playLog.length !== remoteLen || (merged.prefs?.at ?? 0) > ((data.prefs && data.prefs.at) || 0)) await push(userId);
  } catch { /* offline — local profile still works */ }
}

export function stopMusicProfileSync(): void {
  flush();
  unsubscribe?.();
  unsubscribe = null;
  activeUser = null;
}

/** Sign-out: flush, detach and drop back to the anonymous scope so the next
 *  account never reads this one's data. */
export function endMusicProfileSession(): void {
  stopMusicProfileSync();
  setMusicProfileScope(null);
}

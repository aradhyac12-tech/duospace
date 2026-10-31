/**
 * Cross-device sync for Liked Songs + personal playlists (Supabase `music_library`, one row per user).
 *
 * Local storage stays the source the UI reads synchronously (like musicProfileSync.ts); this makes it
 * follow the ACCOUNT. Every cycle is: pull remote -> diff local against the last synced state ->
 * merge per item (see librarySyncMerge.ts) -> apply to local -> push only if the merge differs from
 * remote. The push is optimistic-concurrency (`WHERE updated_at = <pulled value>`): if another phone
 * wrote in between, the cycle simply runs again on the fresh row (max 3 tries).
 *
 * Best effort by design: offline / table missing / RLS error never affects playback or local use;
 * the next change or foreground retries.
 */
import { supabase } from "@/integrations/supabase/appClient";
import { logInfo, logWarn } from "@/lib/telemetry";
import { getMusicProfileScope } from "./playHistory";
import { LIBRARY_EVENT, readLiked, replaceLiked, type StoredTrack } from "./libraryStore";
import { PLAYLISTS_EVENT, readPlaylists, replacePlaylists, type Playlist } from "./playlists";
import {
  canon, diffLocal, emptyState, mergeStates, sanitizeState, stateEq, toLikedList, toPlaylists, type SyncState,
} from "./librarySyncMerge";

export interface LibrarySyncIO {
  readLiked(): StoredTrack[];
  readPlaylists(): Playlist[];
  applyLiked(list: StoredTrack[]): void;
  applyPlaylists(list: Playlist[]): void;
  loadMeta(): SyncState;
  saveMeta(s: SyncState): void;
  /** null = no remote row yet. Throws on network/RLS errors. */
  pull(): Promise<{ state: SyncState; version: string } | null>;
  /** version null = insert. "conflict" = someone else wrote first. Throws on other errors. */
  push(state: SyncState, version: string | null): Promise<"ok" | "conflict">;
  now(): number;
}

export function createLibrarySyncEngine(io: LibrarySyncIO) {
  const hasLocalChanges = (): boolean => {
    const meta = io.loadMeta();
    return canon(diffLocal(meta, io.readLiked(), io.readPlaylists(), io.now())) !== canon(meta);
  };

  async function sync(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const remote = await io.pull();
      const now = io.now();
      const local = diffLocal(io.loadMeta(), io.readLiked(), io.readPlaylists(), now);
      const merged = mergeStates(local, remote?.state ?? emptyState(), now);
      const likedList = toLikedList(merged);
      const pls = toPlaylists(merged);
      if (canon(likedList.map((t) => t.id)) !== canon(io.readLiked().map((t) => t.id))) io.applyLiked(likedList);
      if (canon(pls) !== canon(io.readPlaylists())) io.applyPlaylists(pls);
      io.saveMeta(merged);
      if (remote && stateEq(merged, remote.state)) return;
      if ((await io.push(merged, remote?.version ?? null)) === "ok") return;
    }
  }
  return { sync, hasLocalChanges };
}

// ── Real wiring ────────────────────────────────────────────────────────────
const PUSH_DEBOUNCE_MS = 4_000;
const metaKey = (uid: string) => `groic-library-sync:${uid}`;

function realIO(userId: string): LibrarySyncIO {
  // SAFETY: local storage is scoped per account. If the scope no longer matches this sync's user (sign-out /
  // account switch mid-cycle), reading would see another (or the anonymous, empty) library and the diff would
  // tombstone everything. Abort the cycle instead.
  const guard = () => { if (getMusicProfileScope() !== userId) throw new Error("library scope changed; sync aborted"); };
  return {
    readLiked: () => { guard(); return readLiked(); },
    readPlaylists: () => { guard(); return readPlaylists(); },
    applyLiked: (l) => { guard(); replaceLiked(l); },
    applyPlaylists: (l) => { guard(); replacePlaylists(l); },
    loadMeta: () => { try { return sanitizeState(JSON.parse(localStorage.getItem(metaKey(userId)) || "null")); } catch { return emptyState(); } },
    saveMeta: (s) => { try { localStorage.setItem(metaKey(userId), JSON.stringify(s)); } catch { /* best effort */ } },
    async pull() {
      const { data, error } = await supabase.from("music_library").select("liked, playlists, updated_at").eq("user_id", userId).maybeSingle();
      if (error) throw error;
      return data ? { state: sanitizeState(data), version: String(data.updated_at) } : null;
    },
    async push(state, version) {
      if (version === null) {
        const { error } = await supabase.from("music_library").insert({ user_id: userId, liked: state.liked, playlists: state.playlists });
        if (!error) return "ok";
        if ((error as { code?: string }).code === "23505") return "conflict"; // another phone created the row first
        throw error;
      }
      const { data, error } = await supabase.from("music_library")
        .update({ liked: state.liked, playlists: state.playlists })
        .eq("user_id", userId).eq("updated_at", version).select("user_id");
      if (error) throw error;
      return data && data.length > 0 ? "ok" : "conflict";
    },
    now: () => Date.now(),
  };
}

let active: { userId: string; stop: () => void } | null = null;

export function startLibrarySync(userId: string): void {
  stopLibrarySync();
  const engine = createLibrarySyncEngine(realIO(userId));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let again = false;
  let alive = true;

  const run = async () => {
    if (!alive) return;
    if (running) { again = true; return; }
    running = true;
    try { await engine.sync(); logInfo("librarySync", "synced"); }
    catch (e) { logWarn("librarySync", "sync failed (will retry on next change/foreground)", { error: e instanceof Error ? e.message : String(e) }); }
    finally { running = false; if (again && alive) { again = false; void run(); } }
  };
  const onLocalChange = () => {
    // recordRecentTrack fires LIBRARY_EVENT on every play: only sync when likes/playlists really changed.
    let changed = true;
    try { changed = engine.hasLocalChanges(); } catch { /* sync anyway */ }
    if (!changed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void run(); }, PUSH_DEBOUNCE_MS);
  };
  const onVisible = () => { if (document.visibilityState === "visible") void run(); }; // pick up the other phone's changes
  window.addEventListener(LIBRARY_EVENT, onLocalChange);
  window.addEventListener(PLAYLISTS_EVENT, onLocalChange);
  document.addEventListener("visibilitychange", onVisible);
  void run();
  active = {
    userId,
    stop: () => {
      alive = false;
      if (timer) { clearTimeout(timer); timer = null; void engine.sync().catch(() => {}); } // flush a pending local change
      window.removeEventListener(LIBRARY_EVENT, onLocalChange);
      window.removeEventListener(PLAYLISTS_EVENT, onLocalChange);
      document.removeEventListener("visibilitychange", onVisible);
    },
  };
}

export function stopLibrarySync(): void { active?.stop(); active = null; }

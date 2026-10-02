/**
 * Per-account listening memory: "don't suggest this again" window + the
 * play log that feeds the taste profile (autoNext.ts).
 *
 * ACCOUNT SCOPING (fix): these used to live under the single global
 * localStorage keys "groic-play-history" / "groic-play-log", so one phone
 * shared ONE taste profile between every account that ever signed in on
 * it (and a new account inherited the previous person's suggestions).
 * Everything is now stored under `<key>:<userId>`. GroicContext calls
 * {@link setMusicProfileScope} whenever the signed-in user changes, and
 * musicProfileSync.ts mirrors the scoped data to Supabase so the same
 * account gets the same suggestions on a new phone / after reinstall.
 *
 * Before sign-in resolves the scope is "anon" (kept so the pure helpers
 * and their tests work without an auth context).
 *
 * The recent-plays window is deliberately NOT "never again forever": a
 * rolling window so the pool never shrinks to nothing and a loved song
 * can resurface.
 */
import { songKey } from "./queueQuality";

const PLAY_HISTORY_KEY = "groic-play-history";
const PLAY_LOG_KEY = "groic-play-log";
const PREFS_KEY = "groic-music-prefs";
const LEGACY_RECENT_KEY = "groic-recent";
const LEGACY_LANG_KEY = "groic-lang-prefs";
const PLAY_LOG_MAX = 300;
/** How many distinct recently-played songs are excluded from suggestions. */
const HISTORY_WINDOW = 40;

export interface PlayLogEntry {
  /** songKey-style identity of the track. */
  key: string;
  artist: string;
  /** epoch ms */
  at: number;
  /** User skipped it early (recordSkipped). Counts against the artist. */
  skipped?: boolean;
  /** Played (almost) to the end (recordCompleted). Counts extra for the artist. */
  done?: boolean;
}

/** Small per-account music preferences (previously the global
 *  "groic-recent" / "groic-lang-prefs" keys). `at` = last edit, used to pick
 *  the newer side when merging with the server copy. */
export interface MusicPrefs {
  recent: string[];
  /** null = never chosen (UI falls back to its defaults). */
  langs: string[] | null;
  at: number;
}

export interface MusicProfileData {
  playLog: PlayLogEntry[];
  playHistory: string[];
  prefs?: MusicPrefs;
}

// ── Scope ───────────────────────────────────────────────────────────────────

let scope = "anon";
const listeners = new Set<() => void>();

const scoped = (base: string) => `${base}:${scope}`;

export const getMusicProfileScope = (): string => scope;

/** Switch the active account. Pass null on sign-out. On the first switch to
 *  a real account, adopts the legacy un-scoped data once (so an existing
 *  user's taste isn't wiped by this update) and removes the legacy keys so
 *  the next account on the device does NOT inherit it. */
export function setMusicProfileScope(userId: string | null | undefined): void {
  const next = userId || "anon";
  if (next === scope) return;
  scope = next;
  if (next === "anon") return;
  try {
    const hasOwn = localStorage.getItem(scoped(PLAY_LOG_KEY)) !== null || localStorage.getItem(scoped(PLAY_HISTORY_KEY)) !== null;
    for (const base of [PLAY_LOG_KEY, PLAY_HISTORY_KEY]) {
      const legacy = localStorage.getItem(base);
      if (legacy === null) continue;
      if (!hasOwn) localStorage.setItem(scoped(base), legacy);
      localStorage.removeItem(base);
    }
    const legacyRecent = localStorage.getItem(LEGACY_RECENT_KEY);
    const legacyLang = localStorage.getItem(LEGACY_LANG_KEY);
    if ((legacyRecent !== null || legacyLang !== null) && localStorage.getItem(scoped(PREFS_KEY)) === null) {
      const parse = (v: string | null): unknown => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
      const r = parse(legacyRecent), l = parse(legacyLang);
      localStorage.setItem(scoped(PREFS_KEY), JSON.stringify({
        recent: Array.isArray(r) ? r.filter((x): x is string => typeof x === "string").slice(0, 8) : [],
        langs: Array.isArray(l) ? l.filter((x): x is string => typeof x === "string") : null,
        at: Date.now(),
      }));
    }
    localStorage.removeItem(LEGACY_RECENT_KEY);
    localStorage.removeItem(LEGACY_LANG_KEY);
  } catch { /* private mode */ }
}

/** Fires after the server copy was merged into local (so UI can re-read). */
const loadedListeners = new Set<() => void>();
export function subscribeProfileLoaded(cb: () => void): () => void {
  loadedListeners.add(cb);
  return () => { loadedListeners.delete(cb); };
}

/** Fires after any local change to the active account's profile. */
export function subscribeProfileChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
const emit = () => { if (scope !== "anon") listeners.forEach((l) => { try { l(); } catch { /* listener bug must not break playback */ } }); };

// ── Storage ─────────────────────────────────────────────────────────────────

function readHistory(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(scoped(PLAY_HISTORY_KEY)) || "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Newest first. */
export function readPlayLog(): PlayLogEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(scoped(PLAY_LOG_KEY)) || "[]");
    return Array.isArray(raw)
      ? raw.filter((e): e is PlayLogEntry => !!e && typeof e.key === "string" && typeof e.artist === "string" && typeof e.at === "number")
      : [];
  } catch {
    return [];
  }
}

function writeLog(log: PlayLogEntry[]): void {
  try { localStorage.setItem(scoped(PLAY_LOG_KEY), JSON.stringify(log.slice(0, PLAY_LOG_MAX))); } catch { /* best effort */ }
}

export function getRecentlyPlayedKeys(): Set<string> {
  return new Set(readHistory());
}

// ── Recording ───────────────────────────────────────────────────────────────

/** Once per actual play (GroicContext.playTrack and the native track-changed
 *  path). The key falls back to the raw lowercase title for non-Latin titles
 *  (songKey is "" for Devanagari/Arabic/Hangul…, which used to make such
 *  songs invisible to history and the taste log). */
const keyOf = (title: string): string => songKey(title) || title.toLowerCase().trim();

export function recordPlayed(title: string, artist?: string): void {
  const key = keyOf(title);
  if (!key) return;
  try {
    const next = [key, ...readHistory().filter((k) => k !== key)].slice(0, HISTORY_WINDOW);
    localStorage.setItem(scoped(PLAY_HISTORY_KEY), JSON.stringify(next));
  } catch { /* suggestions just won't get history-aware */ }
  if (artist && artist.trim()) writeLog([{ key, artist: artist.trim(), at: Date.now() }, ...readPlayLog()]);
  emit();
}

/** Skipped early → counts AGAINST its artist. Flags the newest log entry. */
export function recordSkipped(title: string, artist?: string): void {
  const key = keyOf(title);
  if (!key) return;
  const log = readPlayLog();
  const i = log.findIndex((e) => e.key === key);
  if (i >= 0) log[i] = { ...log[i], skipped: true, done: false };
  else if (artist && artist.trim()) log.unshift({ key, artist: artist.trim(), at: Date.now(), skipped: true });
  else return;
  writeLog(log);
  emit();
}

/** Listened through to (near) the end → a stronger "like" than a bare play. */
export function recordCompleted(title: string): void {
  const key = keyOf(title);
  if (!key) return;
  const log = readPlayLog();
  const i = log.findIndex((e) => e.key === key);
  if (i < 0 || log[i].skipped) return;
  log[i] = { ...log[i], done: true };
  writeLog(log);
  emit();
}

// ── Prefs ───────────────────────────────────────────────────────────────────

export function getMusicPrefs(): MusicPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(scoped(PREFS_KEY)) || "null");
    if (raw && typeof raw === "object") {
      return {
        recent: Array.isArray(raw.recent) ? raw.recent.filter((x: unknown): x is string => typeof x === "string").slice(0, 8) : [],
        langs: Array.isArray(raw.langs) ? raw.langs.filter((x: unknown): x is string => typeof x === "string") : null,
        at: typeof raw.at === "number" ? raw.at : 0,
      };
    }
  } catch { /* fall through */ }
  return { recent: [], langs: null, at: 0 };
}

export function setMusicPrefs(patch: Partial<Pick<MusicPrefs, "recent" | "langs">>): void {
  const next: MusicPrefs = { ...getMusicPrefs(), ...patch, at: Date.now() };
  try { localStorage.setItem(scoped(PREFS_KEY), JSON.stringify(next)); } catch { /* best effort */ }
  emit();
}

// ── Sync helpers (pure, used by musicProfileSync.ts) ────────────────────────

export function exportMusicProfile(): MusicProfileData {
  return { playLog: readPlayLog(), playHistory: [...readHistory()], prefs: getMusicPrefs() };
}

/** Union of two logs (same key+timestamp = same event; flags are OR-ed),
 *  newest first, capped. */
export function mergePlayLogs(a: readonly PlayLogEntry[], b: readonly PlayLogEntry[]): PlayLogEntry[] {
  const byId = new Map<string, PlayLogEntry>();
  for (const e of [...a, ...b]) {
    const id = `${e.key}@${e.at}`;
    const prev = byId.get(id);
    byId.set(id, prev ? { ...prev, skipped: prev.skipped || e.skipped || undefined, done: (prev.done || e.done) && !(prev.skipped || e.skipped) ? true : undefined } : e);
  }
  return [...byId.values()].sort((x, y) => y.at - x.at).slice(0, PLAY_LOG_MAX);
}

export function mergeHistoryKeys(log: readonly PlayLogEntry[], ...lists: readonly (readonly string[])[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (k: string) => { if (k && !seen.has(k)) { seen.add(k); out.push(k); } };
  for (const e of log) push(e.key);
  for (const l of lists) for (const k of l) push(k);
  return out.slice(0, HISTORY_WINDOW);
}

/** Merge remote data into the active account's local profile; returns the merged result. */
export function importMusicProfile(remote: Partial<MusicProfileData> | null | undefined): MusicProfileData {
  const local = exportMusicProfile();
  const log = mergePlayLogs(local.playLog, Array.isArray(remote?.playLog) ? remote!.playLog!.filter((e) => e && typeof e.key === "string" && typeof e.artist === "string" && typeof e.at === "number") : []);
  const history = mergeHistoryKeys(log, local.playHistory, Array.isArray(remote?.playHistory) ? remote!.playHistory!.filter((k) => typeof k === "string") : []);
  writeLog(log);
  try { localStorage.setItem(scoped(PLAY_HISTORY_KEY), JSON.stringify(history)); } catch { /* noop */ }
  // Prefs: the more recently edited side wins.
  const rp = remote?.prefs;
  const remotePrefs: MusicPrefs | null = rp && typeof rp === "object" && typeof rp.at === "number"
    ? { recent: Array.isArray(rp.recent) ? rp.recent.filter((x) => typeof x === "string").slice(0, 8) : [], langs: Array.isArray(rp.langs) ? rp.langs.filter((x) => typeof x === "string") : null, at: rp.at }
    : null;
  let prefs = local.prefs ?? getMusicPrefs();
  if (remotePrefs && remotePrefs.at > prefs.at) {
    prefs = remotePrefs;
    try { localStorage.setItem(scoped(PREFS_KEY), JSON.stringify(prefs)); } catch { /* noop */ }
  }
  loadedListeners.forEach((l) => { try { l(); } catch { /* ignore */ } });
  return { playLog: log, playHistory: history, prefs };
}

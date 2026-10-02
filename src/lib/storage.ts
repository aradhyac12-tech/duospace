/**
 * Safe cross-platform storage utility.
 * Uses localStorage with try/catch on all platforms.
 * On native Capacitor, Supabase auth uses @capacitor/preferences (see client.ts).
 * All other app preferences (keys, settings, etc.) use this wrapper.
 */
const storage = {
  get(key: string, fallback: string | null = null): string | null {
    try { return localStorage.getItem(key) ?? fallback; }
    catch { return fallback; }
  },
  set(key: string, value: string): void {
    try { localStorage.setItem(key, value); }
    catch { /* quota exceeded or private mode */ }
  },
  remove(key: string): void {
    try { localStorage.removeItem(key); }
    catch { /* noop */ }
  },
  getJSON<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  },
  setJSON(key: string, value: unknown): void {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch { /* noop */ }
  },
};

export default storage;

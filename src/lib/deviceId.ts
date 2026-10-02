import { prefs } from "@/lib/prefs";

// A stable per-install identifier — not a hardware id (Apple/Google both
// restrict those), just a random UUID generated once and persisted via
// @capacitor/preferences (native SharedPreferences/UserDefaults, survives
// app restarts but not reinstalls). Used to key push_tokens rows
// (user_id, device_id, token_type) so a token *rotation* on the same
// physical install upserts in place instead of accumulating stale rows —
// see the unique index in supabase/migrations/20260808120000_ios_voip_push.sql.
const STORAGE_KEY = "duospace_device_id";

let cached: string | null = null;

function randomUuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  // Fallback for older WebViews without crypto.randomUUID.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export async function getDeviceId(): Promise<string> {
  if (cached) return cached;
  const value = await prefs.get(STORAGE_KEY);
  if (value) {
    cached = value;
    return value;
  }
  const id = randomUuid();
  await prefs.set(STORAGE_KEY, id);
  cached = id;
  return id;
}

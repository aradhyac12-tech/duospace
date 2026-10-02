import { secureGet, secureSet } from "@/lib/privacy/secureStorage";
import { logWarn } from "@/lib/telemetry";
import {
  emptyProfile, learnConfirmed, updateBaseline, type Feat, type MoodProfile,
} from "@/lib/moodProfile";

/**
 * On-device persistence for the per-person mood profile (see moodProfile.ts). AES-GCM via secureStorage,
 * scoped to the signed-in user and wiped on sign-out (secureWipeAll). NEVER uploaded: not in mood_logs, not in
 * any table, not in telemetry. A tiny sync cache keeps scoring synchronous; loads are async and best-effort —
 * until a load finishes, scoring simply runs without personalization.
 */
const KEY = "mood_profile_v1";
const cache = new Map<string, MoodProfile>();
const loading = new Map<string, Promise<MoodProfile>>();

export const getMoodProfile = (userId: string | null | undefined): MoodProfile | null =>
  (userId && cache.get(userId)) || null;

export const loadMoodProfile = (userId: string): Promise<MoodProfile> => {
  const hit = cache.get(userId);
  if (hit) return Promise.resolve(hit);
  let p = loading.get(userId);
  if (!p) {
    p = secureGet<MoodProfile>(userId, KEY)
      .then((stored) => {
        const ok = stored && stored.v === 1 && stored.baseline && stored.protos;
        const prof = ok ? stored : emptyProfile();
        // A write that raced the load wins (cache already populated by a learn/update).
        if (!cache.has(userId)) cache.set(userId, prof);
        return cache.get(userId)!;
      })
      .catch((err) => { logWarn("moodProfile", "load failed — continuing without personalization", err); return emptyProfile(); })
      .finally(() => loading.delete(userId));
    loading.set(userId, p);
  }
  return p;
};

const commit = async (userId: string, next: MoodProfile): Promise<void> => {
  cache.set(userId, next);
  try { await secureSet(userId, KEY, next); }
  catch (err) { logWarn("moodProfile", "save failed — profile kept in memory only", err); }
};

/** Fold this session's resting baseline into the learned baseline. */
export const noteRestingBaseline = async (userId: string, sessionBaseline: Feat): Promise<void> => {
  const cur = cache.get(userId) ?? (await loadMoodProfile(userId));
  await commit(userId, updateBaseline(cur, sessionBaseline));
};

/** The person tapped 👍 on this mood: remember what their face looked like. */
export const learnMoodConfirmed = async (userId: string, mood: string, features: Feat, baselineUsed: Feat): Promise<void> => {
  const cur = cache.get(userId) ?? (await loadMoodProfile(userId));
  await commit(userId, learnConfirmed(cur, mood, features, baselineUsed));
};

/** Drop the in-memory copy (sign-out). Persistent copy is removed by secureWipeAll. */
export const clearMoodProfileCache = (): void => { cache.clear(); loading.clear(); };

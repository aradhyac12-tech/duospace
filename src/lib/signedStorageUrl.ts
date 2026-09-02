// Shared helper for resolving a private-bucket storage object to a URL the
// browser can actually load.
//
// BUG FIX: several places stored `supabase.storage.from(bucket).getPublicUrl(path)`
// output directly as the display URL. getPublicUrl() just constructs a
// "/object/public/<bucket>/<path>" string — it does NOT check whether the
// bucket is actually public, and doesn't error if it isn't. Every bucket this
// app uses (gallery, chat-files, memories) is private (correctly — this is a
// private couples app), so those URLs 403 and every photo/video/voice-note
// renders as a broken image. This derives the object path back out of a
// previously-stored URL (public-shaped or already-signed, either way) and
// mints a fresh signed URL instead, which the "read own or partner files"
// RLS policy on storage.objects allows for the owner and their linked partner.
//
// CRITICAL FIX (media disappearing for receiver): when createSignedUrl fails
// (storage object not yet visible due to propagation lag), the old code fell
// back to returning the raw pseudoPublicUrl — a non-fetchable URL for a
// private bucket, causing 403 and invisible media. Now retries with backoff
// before falling back, and never returns a URL that's known to be broken.
// AUDIT FIX (Phase 7, Gallery/Image System): this file's own prior comment
// said "call sites re-sign on every load anyway" as if that were a neutral
// fact — it's actually the root cause of the exact flicker this phase's
// brief calls out ("photos never flash", "no unnecessary re-decoding", "no
// duplicate downloads", "loaded-image preservation"). Every signed URL
// carries a unique token in its query string, so re-signing the SAME photo
// on every refetch (gallery reload on remount, a realtime item arriving,
// Chat's own message refetch) produced a DIFFERENT <img src> for content
// that hadn't actually changed — and browsers cache by exact URL, so a
// changed src forces a full re-download and re-decode even though nothing
// about the photo did. This is the one signed-URL resolver every photo
// surface in the app goes through (Gallery, Chat, PhotoViewer, MemoryWall),
// so caching here fixes all four at once with no call-site changes.
import { supabase } from "@/integrations/supabase/client";

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 6; // 6 days
const MAX_RETRY_ATTEMPTS = 4;
const RETRY_DELAYS = [0, 300, 700, 1500]; // ms

// Cached by (bucket, path) — the STABLE identity of a stored object —
// rather than by the signed URL itself, and returned as-is on a cache hit
// so the same object always resolves to the same src string within the
// cache window instead of minting a fresh token on every call. TTL kept
// safely under the signed URL's own expiry so nothing cached is ever
// handed out that's about to 403.
const urlCache = new Map<string, { url: string; expiresAt: number }>();
const CACHE_SAFETY_MARGIN_MS = 5 * 60 * 1000; // re-sign 5 min before actual expiry, never cut it close
const MAX_CACHE_ENTRIES = 800; // generous for a private couple's gallery; evicts oldest on overflow rather than growing unbounded across a very long session

function cacheGet(key: string): string | null {
  const hit = urlCache.get(key);
  if (!hit) return null;
  if (Date.now() >= hit.expiresAt) { urlCache.delete(key); return null; }
  return hit.url;
}

function cacheSet(key: string, url: string, ttlSeconds: number) {
  if (urlCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = urlCache.keys().next().value;
    if (oldest) urlCache.delete(oldest);
  }
  urlCache.set(key, { url, expiresAt: Date.now() + ttlSeconds * 1000 - CACHE_SAFETY_MARGIN_MS });
}

export function extractStoragePath(bucket: string, rawUrl: string): string | null {
  const marker = `/${bucket}/`;
  const idx = rawUrl.indexOf(marker);
  if (idx === -1) return null;
  const afterBucket = rawUrl.slice(idx + marker.length);
  return afterBucket.split("?")[0] || null;
}

export async function resolveSignedUrl(
  bucket: string,
  rawUrl: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<string | null> {
  if (!rawUrl) return rawUrl;
  const path = extractStoragePath(bucket, rawUrl);
  if (!path) return rawUrl;

  const cacheKey = `${bucket}:${path}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // Retry with backoff: storage objects may not be immediately visible
  // after upload (propagation lag). The old code returned rawUrl on
  // failure, but rawUrl is a pseudoPublicUrl for a private bucket → 403.
  for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt] ?? 1500));
    }
    try {
      const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, ttlSeconds);
      if (!error && data?.signedUrl) {
        cacheSet(cacheKey, data.signedUrl, ttlSeconds);
        return data.signedUrl;
      }
    } catch {
      // transient error — retry
    }
  }

  // All retries exhausted — return null instead of rawUrl. The raw URL is
  // a pseudoPublicUrl for a private bucket → guaranteed 403, which renders
  // as invisible/broken media. Returning null lets the caller fall back
  // to _localPreviewUrl (sender side) or show the message without media
  // (receiver side) — both are better than a broken image.
  return null;
}

export async function resolveSignedUrls<T extends object>(
  bucket: string,
  items: T[],
  urlField: keyof T,
  ttlSeconds?: number,
): Promise<T[]> {
  return Promise.all(items.map(async (item) => ({
    ...item,
    [urlField]: await resolveSignedUrl(bucket, String(item[urlField] ?? ""), ttlSeconds),
  })));
}

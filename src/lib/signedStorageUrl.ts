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
import { supabase } from "@/integrations/supabase/client";

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 6; // 6 days — call sites re-sign on every load anyway

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
): Promise<string> {
  if (!rawUrl) return rawUrl;
  const path = extractStoragePath(bucket, rawUrl);
  if (!path) return rawUrl;
  try {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, ttlSeconds);
    if (error || !data?.signedUrl) return rawUrl;
    return data.signedUrl;
  } catch {
    return rawUrl;
  }
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

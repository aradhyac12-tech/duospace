// The single entry point the rest of the app uses for media. Components never learn
// whether a file lives in Cloudinary or in legacy Supabase Storage.
import { isCloudinaryEnabledFor } from "./config";
import { deleteCloudinaryMedia, registerWithRetry, resolveMedia, uploadToCloudinary, type ResolvedMedia } from "./cloudinary";
import { resolveLegacyMediaUrl } from "./legacySupabaseMedia";
import { isMediaRef, parseMediaRef } from "./mediaRef";
import { defaultVariantForBucket, type ImageVariant, type MediaVariant } from "./transformations";
import { MediaError, type MediaAsset, type MediaScope, type UploadOptions, type UploadResult } from "./types";

export { isMediaRef, parseMediaRef, toMediaRef } from "./mediaRef";
export { aspectRatioOf, isCloudinaryUrl } from "./transformations";
export type { MediaVariant, ImageVariant, VideoVariant } from "./transformations";
export type { ResolvedMedia } from "./cloudinary";
export * from "./types";
export { isCloudinaryEnabledFor } from "./config";

/** Upload to Cloudinary (authenticated) and register it. Throws MediaError; the state callback always ends in a terminal state. */
export function uploadMedia(file: Blob, opts: UploadOptions): Promise<UploadResult> {
  return uploadToCloudinary(file, opts);
}
/** Finish a registration that failed after the bytes were uploaded (MediaError.mediaId). */
export function registerMedia(mediaId: string): Promise<MediaAsset> { return registerWithRetry(mediaId); }

/**
 * Display URL for any stored media reference:
 *   "media:<uuid>"            -> signed Cloudinary URL (authorization checked server-side)
 *   anything else (legacy)    -> existing Supabase signed-URL path, unchanged
 */
export async function getMediaUrl(ref: string | null | undefined, opts: { bucket: string; variant?: MediaVariant }): Promise<string | null> {
  if (!ref) return null;
  const id = parseMediaRef(ref);
  if (!id) return resolveLegacyMediaUrl(opts.bucket, ref);
  return (await resolveMedia(id, opts.variant ?? defaultVariantForBucket(opts.bucket), opts.bucket))?.url ?? null;
}
/** Same as getMediaUrl but also returns dimensions so the layout can reserve space. Legacy media has none. */
export async function getMediaInfo(ref: string, opts: { bucket: string; variant?: MediaVariant }): Promise<ResolvedMedia | null> {
  const id = parseMediaRef(ref);
  if (!id) { const url = await resolveLegacyMediaUrl(opts.bucket, ref); return url ? { url, width: null, height: null, duration: null, mediaType: "image" } : null; }
  return resolveMedia(id, opts.variant ?? defaultVariantForBucket(opts.bucket), opts.bucket);
}
export const getOptimizedImageUrl = (ref: string, variant: ImageVariant, bucket = "gallery") => getMediaUrl(ref, { bucket, variant });
export const getThumbnailUrl = (ref: string, bucket = "gallery") => getMediaUrl(ref, { bucket, variant: bucket === "chat-files" ? "CHAT_THUMBNAIL" : "GALLERY_PREVIEW" });
export const getVideoUrl = (ref: string, bucket = "gallery") => getMediaUrl(ref, { bucket, variant: "VIDEO_STREAM" });
export const getVideoPosterUrl = (ref: string, bucket = "gallery") => getMediaUrl(ref, { bucket, variant: "VIDEO_POSTER" });

/** Delete a Cloudinary-backed item (server verifies ownership). Legacy refs are NOT handled here: callers keep their existing Supabase deletion. */
export async function deleteMedia(ref: string | null | undefined, bucketHint?: string): Promise<void> {
  const id = parseMediaRef(ref);
  if (!id) return;
  await deleteCloudinaryMedia(id, bucketHint);
}

export const canUseCloudinary = (scope: MediaScope) => isCloudinaryEnabledFor(scope);
export { MediaError };

// Client-side view of the server's signed variants. The client only ever names a variant;
// the server owns the actual Cloudinary transformation strings (and signs them).
export type ImageVariant = "AVATAR" | "CHAT_THUMBNAIL" | "GALLERY_PREVIEW" | "FULLSCREEN";
export type VideoVariant = "VIDEO_STREAM" | "VIDEO_POSTER" | "VIDEO_THUMBNAIL";
export type MediaVariant = ImageVariant | VideoVariant;

export type LegacyBucket = "chat-files" | "gallery" | "memories" | "avatars";
/** Variant used when a legacy-shaped call site (resolveSignedUrl(bucket, url)) hits a media ref.
 *  Videos are adapted to VIDEO_STREAM server-side. */
export const defaultVariantForBucket = (bucket: string): ImageVariant =>
  bucket === "avatars" ? "AVATAR" : bucket === "chat-files" ? "CHAT_THUMBNAIL" : "GALLERY_PREVIEW";

export const isVideoVariant = (v: MediaVariant): v is VideoVariant => v.startsWith("VIDEO_");

/** CSS aspect-ratio value so layout is reserved before the bytes arrive. */
export const aspectRatioOf = (a: { width?: number | null; height?: number | null }): string | undefined =>
  a.width && a.height ? `${a.width} / ${a.height}` : undefined;

export const isCloudinaryUrl = (u: string | null | undefined): boolean =>
  !!u && /^https:\/\/res\.cloudinary\.com\//.test(u);

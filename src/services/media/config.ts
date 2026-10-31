// Central, documented media limits + feature flags. Server limits (MEDIA_MAX_* secrets /
// supabase/functions/_shared/cloudinaryCore.ts DEFAULT_LIMITS) are authoritative; keep in sync.
// Cloudinary plan caps apply on top (free plan: 10 MB image / 100 MB video).
export const MEDIA_LIMITS = {
  maxImageBytes: 20 * 1024 * 1024,
  maxVideoBytes: 100 * 1024 * 1024,
  maxVideoSeconds: 600,
  maxDimension: 12000,
} as const;

export const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif", "image/avif"] as const;
export const VIDEO_MIMES = ["video/mp4", "video/quicktime", "video/webm", "video/3gpp"] as const;

export const UPLOAD_TIMEOUT_MS = 15 * 60 * 1000;   // 100 MB on a weak mobile link
export const UPLOAD_NETWORK_RETRIES = 2;            // same signature is reused (valid ~1h)
export const REGISTER_RETRIES = 3;

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
/** The public cloud name doubles as "Cloudinary is configured for this build". */
export const CLOUDINARY_CONFIGURED = !!env.VITE_CLOUDINARY_CLOUD_NAME;
/** Gallery / Memories / avatars: on once configured (opt out with VITE_CLOUDINARY_MEDIA_ENABLED=false). */
export const CLOUDINARY_MEDIA_ENABLED = CLOUDINARY_CONFIGURED && env.VITE_CLOUDINARY_MEDIA_ENABLED !== "false";
/** Chat is the high-risk surface: explicit opt-in only. Default OFF = Chat behaves exactly as before. */
export const CLOUDINARY_CHAT_MEDIA_ENABLED = CLOUDINARY_CONFIGURED && env.VITE_CLOUDINARY_CHAT_MEDIA_ENABLED === "true";

export const isCloudinaryEnabledFor = (scope: "profile" | "chat" | "gallery" | "memories") =>
  scope === "chat" ? CLOUDINARY_CHAT_MEDIA_ENABLED : CLOUDINARY_MEDIA_ENABLED;

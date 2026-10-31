// Pure Cloudinary helpers shared by the media edge functions (no Deno globals, so
// they are unit-tested under vitest: src/test/cloudinaryCore.test.ts).
//
// SECURITY: nothing here reads secrets from the environment; callers pass the
// config in. CLOUDINARY_API_SECRET therefore only ever exists inside edge
// functions (cloudinaryApi.ts / the four function entrypoints).

export const SCOPES = ["profile", "chat", "gallery", "memories"] as const;
export type MediaScope = (typeof SCOPES)[number];
export type ResourceType = "image" | "video";

export const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif", "image/avif"] as const;
export const VIDEO_MIMES = ["video/mp4", "video/quicktime", "video/webm", "video/3gpp"] as const;

export interface MediaLimits {
  maxImageBytes: number;
  maxVideoBytes: number;
  maxVideoSeconds: number;
  maxDimension: number;
}
// Defaults are deliberately generous for a private couples app. Cloudinary's own
// per-plan upload caps still apply (free plan: 10 MB image / 100 MB video) — set
// MEDIA_MAX_* secrets to match the plan. Mirror any change in src/services/media/config.ts.
export const DEFAULT_LIMITS: MediaLimits = {
  maxImageBytes: 20 * 1024 * 1024,
  maxVideoBytes: 100 * 1024 * 1024,
  maxVideoSeconds: 600,
  maxDimension: 12000,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

export const resourceTypeForMime = (mime: string): ResourceType | null =>
  (IMAGE_MIMES as readonly string[]).includes(mime) ? "image"
  : (VIDEO_MIMES as readonly string[]).includes(mime) ? "video" : null;

// ── folder / public id ──────────────────────────────────────────────────────
// duospace/users/{user_uuid}/{scope}/{media_uuid}. UUIDs only — no names/emails.
// The client never supplies any part of this except an optional idempotency UUID.
export const folderFor = (userId: string, scope: MediaScope) => `duospace/users/${userId}/${scope}`;
export const publicIdFor = (userId: string, scope: MediaScope, mediaId: string) => `${folderFor(userId, scope)}/${mediaId}`;

export function parsePublicId(publicId: string): { userId: string; scope: MediaScope; mediaId: string } | null {
  const m = /^duospace\/users\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(publicId);
  if (!m || !isUuid(m[1]) || !isUuid(m[3]) || !(SCOPES as readonly string[]).includes(m[2])) return null;
  return { userId: m[1], scope: m[2] as MediaScope, mediaId: m[3] };
}

// ── sign request validation ─────────────────────────────────────────────────
export type Validation<T> = { ok: true; value: T } | { ok: false; code: string; error: string };

export interface SignRequest { scope: MediaScope; mime: string; resourceType: ResourceType; bytes: number; clientUploadId?: string; filename?: string }

export function validateSignRequest(body: unknown, limits: MediaLimits = DEFAULT_LIMITS): Validation<SignRequest> {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!(SCOPES as readonly string[]).includes(b.scope as string)) return { ok: false, code: "INVALID_SCOPE", error: "Unknown media scope" };
  const mime = typeof b.mime_type === "string" ? b.mime_type.toLowerCase() : "";
  const resourceType = resourceTypeForMime(mime);
  if (!resourceType) return { ok: false, code: "UNSUPPORTED_TYPE", error: "Unsupported file type" };
  if (b.resource_type !== undefined && b.resource_type !== resourceType) return { ok: false, code: "TYPE_MISMATCH", error: "resource_type does not match mime_type" };
  const bytes = Number(b.bytes);
  if (!Number.isFinite(bytes) || bytes <= 0) return { ok: false, code: "INVALID_SIZE", error: "bytes must be a positive number" };
  const max = resourceType === "image" ? limits.maxImageBytes : limits.maxVideoBytes;
  if (bytes > max) return { ok: false, code: "TOO_LARGE", error: `File exceeds the ${Math.round(max / 1048576)} MB limit` };
  if (b.scope === "profile" && resourceType !== "image") return { ok: false, code: "INVALID_SCOPE", error: "Profile media must be an image" };
  if (b.scope === "memories" && resourceType !== "image") return { ok: false, code: "INVALID_SCOPE", error: "Memories accept images only" };
  if (b.client_upload_id !== undefined && !isUuid(b.client_upload_id)) return { ok: false, code: "INVALID_BODY", error: "client_upload_id must be a UUID" };
  const filename = typeof b.original_filename === "string" ? sanitizeFilename(b.original_filename) : undefined;
  return { ok: true, value: { scope: b.scope as MediaScope, mime, resourceType, bytes, clientUploadId: b.client_upload_id as string | undefined, filename } };
}

export const sanitizeFilename = (n: string): string | undefined => {
  const cleaned = n.replace(/[\u0000-\u001f\u007f/\\]/g, "").trim().slice(0, 200);
  return cleaned || undefined;
};

// ── hashing / signing ───────────────────────────────────────────────────────
const enc = new TextEncoder();
async function sha1(input: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-1", enc.encode(input)));
}
export async function sha1Hex(input: string): Promise<string> {
  return Array.from(await sha1(input)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Cloudinary API signature: sort params, join k=v with &, append secret, SHA-1 hex.
 *  file / cloud_name / resource_type / api_key are never part of it. */
export async function signApiParams(params: Record<string, string | number | boolean | undefined>, apiSecret: string): Promise<string> {
  const skip = new Set(["file", "cloud_name", "resource_type", "api_key"]);
  const str = Object.keys(params).filter((k) => !skip.has(k) && params[k] !== undefined && params[k] !== "")
    .sort().map((k) => `${k}=${params[k]}`).join("&");
  return sha1Hex(str + apiSecret);
}

export interface UploadAuthorization {
  uploadUrl: string; apiKey: string; cloudName: string; timestamp: number; signature: string;
  publicId: string; type: "authenticated"; resourceType: ResourceType;
}
export async function buildUploadAuthorization(
  cfg: { cloudName: string; apiKey: string; apiSecret: string },
  a: { publicId: string; resourceType: ResourceType; nowSeconds: number },
): Promise<UploadAuthorization> {
  const signedParams = { public_id: a.publicId, timestamp: a.nowSeconds, type: "authenticated" };
  const signature = await signApiParams(signedParams, cfg.apiSecret);
  return {
    uploadUrl: `https://api.cloudinary.com/v1_1/${cfg.cloudName}/${a.resourceType}/upload`,
    apiKey: cfg.apiKey, cloudName: cfg.cloudName, timestamp: a.nowSeconds, signature,
    publicId: a.publicId, type: "authenticated", resourceType: a.resourceType,
  };
}

// ── delivery variants (the ONLY transformations the server will sign) ───────
// The client sends a variant NAME, never a raw transformation string, so a client
// cannot request unbounded/expensive transformations on the account's quota.
export interface Variant { resource: ResourceType; transformation: string; ext?: string }
export const VARIANTS = {
  AVATAR:            { resource: "image", transformation: "c_fill,g_auto,w_256,h_256,f_auto,q_auto" },
  CHAT_THUMBNAIL:    { resource: "image", transformation: "c_limit,w_720,h_720,f_auto,q_auto" },
  GALLERY_PREVIEW:   { resource: "image", transformation: "c_limit,w_1280,h_1280,f_auto,q_auto" },
  FULLSCREEN:        { resource: "image", transformation: "c_limit,w_2048,h_2048,f_auto,q_auto" },
  VIDEO_STREAM:      { resource: "video", transformation: "c_limit,w_1280,h_1280,f_auto,q_auto,vc_auto" },
  VIDEO_POSTER:      { resource: "video", transformation: "so_0,c_limit,w_720,h_720,f_jpg,q_auto", ext: "jpg" },
  VIDEO_THUMBNAIL:   { resource: "video", transformation: "so_0,c_fill,g_auto,w_480,h_480,f_jpg,q_auto", ext: "jpg" },
} as const satisfies Record<string, Variant>;
export type VariantName = keyof typeof VARIANTS;
export const isVariantName = (v: unknown): v is VariantName => typeof v === "string" && Object.prototype.hasOwnProperty.call(VARIANTS, v);

/** Callers that only hold a media ref (not whether it is a photo or a video) ask for an
 *  image variant; videos get the stream variant. A video variant requested for an image
 *  is NOT adapted (impossible request -> VARIANT_MISMATCH). */
export function adaptVariant(variant: VariantName, resourceType: ResourceType): VariantName {
  return resourceType === "video" && VARIANTS[variant].resource === "image" ? "VIDEO_STREAM" : variant;
}

/** `s--XXXXXXXX--` segment: first 8 chars of URL-safe base64 of SHA-1(to_sign + secret),
 *  where to_sign = "<transformation>/<public_id>[.ext]" (version is not signed). */
export async function deliverySignature(toSign: string, apiSecret: string): Promise<string> {
  const bytes = await sha1(toSign + apiSecret);
  let bin = ""; bytes.forEach((b) => (bin += String.fromCharCode(b)));
  const b64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return b64.slice(0, 8);
}

export async function buildSignedDeliveryUrl(
  cfg: { cloudName: string; apiSecret: string },
  a: { publicId: string; resourceType: ResourceType; variant: VariantName },
): Promise<string> {
  const v: Variant = VARIANTS[a.variant];
  if (v.resource !== a.resourceType) throw new Error("VARIANT_RESOURCE_MISMATCH");
  const source = a.publicId + (v.ext ? `.${v.ext}` : "");
  const sig = await deliverySignature(`${v.transformation}/${source}`, cfg.apiSecret);
  return `https://res.cloudinary.com/${cfg.cloudName}/${a.resourceType}/authenticated/s--${sig}--/${v.transformation}/${source}`;
}

// ── verifying what Cloudinary actually stored ───────────────────────────────
export interface CloudinaryResource {
  asset_id?: string; public_id?: string; resource_type?: string; type?: string; format?: string;
  bytes?: number; width?: number; height?: number; duration?: number;
}
export interface IntentLike { cloudinary_public_id: string; resource_type: ResourceType; max_bytes: number }

export function validateStoredResource(r: CloudinaryResource, intent: IntentLike, limits: MediaLimits = DEFAULT_LIMITS): Validation<true> {
  if (r.public_id !== intent.cloudinary_public_id) return { ok: false, code: "PUBLIC_ID_MISMATCH", error: "Asset does not match the upload" };
  if (r.type !== "authenticated") return { ok: false, code: "NOT_AUTHENTICATED", error: "Asset is not an authenticated asset" };
  if (r.resource_type !== intent.resource_type) return { ok: false, code: "TYPE_MISMATCH", error: "Asset resource type mismatch" };
  if (typeof r.bytes !== "number" || r.bytes <= 0 || r.bytes > intent.max_bytes) return { ok: false, code: "TOO_LARGE", error: "Stored asset exceeds the allowed size" };
  if ((r.width ?? 0) > limits.maxDimension || (r.height ?? 0) > limits.maxDimension) return { ok: false, code: "TOO_LARGE", error: "Dimensions exceed the allowed maximum" };
  if (intent.resource_type === "video" && (r.duration ?? 0) > limits.maxVideoSeconds) return { ok: false, code: "TOO_LONG", error: "Video exceeds the allowed duration" };
  return { ok: true, value: true };
}

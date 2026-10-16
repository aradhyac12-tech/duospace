// Cloudinary provider: signed direct upload, registration, signed-URL resolution, deletion.
// UI code never imports this — it goes through mediaService.ts. No secret exists here:
// the upload signature and every delivery URL are minted by Supabase edge functions.
import { invokeEdgeFunction, EdgeFunctionError } from "@/lib/edgeFunction";
import { isOnlineNow } from "@/lib/connectivity";
import { logInfo, logWarn } from "@/lib/telemetry";
import { cacheMediaInBackground, deleteLocalMedia, getLocalMediaUrl } from "@/lib/mediaCache";
import { REGISTER_RETRIES, UPLOAD_NETWORK_RETRIES, UPLOAD_TIMEOUT_MS } from "./config";
import { toMediaRef } from "./mediaRef";
import { isVideoVariant, type MediaVariant } from "./transformations";
import { MediaError, type MediaAsset, type UploadOptions, type UploadResult, type UploadState } from "./types";
import { validateMediaFile } from "./validation";

interface SignResponse {
  ok: true; media_id: string; uploadUrl: string; apiKey: string; timestamp: number; signature: string;
  publicId: string; type: "authenticated";
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bodyCode = (e: unknown): string | undefined => (e instanceof EdgeFunctionError ? (e.responseBody as { code?: string } | undefined)?.code : undefined);

// ── upload ──────────────────────────────────────────────────────────────────
const active = new Map<string, Promise<UploadResult>>();

/** Idempotent per clientUploadId: a double-tap / re-render while uploading returns the same promise. */
export function uploadToCloudinary(file: Blob, opts: UploadOptions): Promise<UploadResult> {
  const id = opts.clientUploadId;
  if (id && active.has(id)) return active.get(id)!;
  const p = runUpload(file, opts).finally(() => { if (id) active.delete(id); });
  if (id) active.set(id, p);
  return p;
}

async function runUpload(file: Blob, opts: UploadOptions): Promise<UploadResult> {
  const st: { v: UploadState } = { v: "idle" };
  const set = (s: UploadState) => { st.v = s; opts.onState?.(s); };
  const aborted = () => opts.signal?.aborted === true;
  const fail = (e: MediaError): never => { set(e.code === "CANCELLED" ? "cancelled" : "failed"); throw e; };
  try {
    if (!isOnlineNow()) fail(new MediaError("OFFLINE", "You're offline", undefined, true));
    set("validating");
    const { mime, kind } = await validateMediaFile(file, opts.scope);
    if (aborted()) fail(new MediaError("CANCELLED", "Upload cancelled"));

    set("signing");
    let auth: SignResponse;
    try {
      auth = await invokeEdgeFunction<SignResponse>("sign-cloudinary-upload", {
        body: { scope: opts.scope, mime_type: mime, resource_type: kind, bytes: file.size, client_upload_id: opts.clientUploadId, original_filename: opts.filename },
      });
    } catch (e) {
      const status = e instanceof EdgeFunctionError ? e.status : undefined;
      const code = bodyCode(e);
      if (code === "NOT_CONFIGURED") return fail(new MediaError("NOT_CONFIGURED", "Media service isn't set up", undefined, false));
      if (status === 401) return fail(new MediaError("UNAUTHORIZED", "Please sign in again"));
      if (e instanceof EdgeFunctionError && (e.cause === "network" || e.cause === "timeout")) return fail(new MediaError("NETWORK", "Network problem", undefined, true));
      return fail(new MediaError("SIGN_FAILED", e instanceof Error ? e.message : "Couldn't start the upload", undefined, status === 429 || (status ?? 0) >= 500));
    }
    if (aborted()) fail(new MediaError("CANCELLED", "Upload cancelled"));

    set("uploading");
    let uploaded = false;
    for (let attempt = 0; attempt <= UPLOAD_NETWORK_RETRIES && !uploaded; attempt++) {
      if (attempt > 0) await sleep(800 * 2 ** (attempt - 1));
      try {
        await xhrUpload(file, auth, opts);
        uploaded = true;
      } catch (e) {
        if (e instanceof MediaError && !e.retryable) return fail(e);
        if (attempt === UPLOAD_NETWORK_RETRIES) return fail(e instanceof MediaError ? e : new MediaError("UPLOAD_FAILED", "Upload failed", undefined, true));
        logWarn("media.upload", "upload attempt failed, retrying", { attempt, mediaId: auth.media_id });
      }
    }

    set("processing"); // bytes are in Cloudinary; derived variants are generated on first delivery request
    set("registering");
    const asset = await registerWithRetry(auth.media_id, { mime_type: mime, original_filename: opts.filename });
    set("complete");
    logInfo("media.upload", "complete", { mediaId: asset.id, scope: opts.scope, kind });
    return { mediaId: asset.id, ref: toMediaRef(asset.id), asset };
  } catch (e) {
    if (st.v !== "failed" && st.v !== "cancelled") set("failed");
    throw e instanceof MediaError ? e : new MediaError("UNKNOWN", e instanceof Error ? e.message : "Upload failed");
  }
}

function xhrUpload(file: Blob, a: SignResponse, opts: UploadOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    // The File/Blob is handed to the browser, which streams it from disk — it is never read into JS memory.
    form.append("file", file);
    form.append("api_key", a.apiKey);
    form.append("timestamp", String(a.timestamp));
    form.append("signature", a.signature);
    form.append("public_id", a.publicId);
    form.append("type", a.type);
    xhr.open("POST", a.uploadUrl);
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) opts.onProgress?.(e.loaded, e.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { opts.onProgress?.(file.size, file.size); return resolve(); }
      let msg = `Upload rejected (${xhr.status})`;
      try { msg = JSON.parse(xhr.responseText)?.error?.message ?? msg; } catch { /* keep default */ }
      reject(new MediaError("UPLOAD_FAILED", msg, undefined, xhr.status >= 500 || xhr.status === 429));
    };
    xhr.onerror = () => reject(new MediaError("NETWORK", "Network error during upload", undefined, true));
    xhr.ontimeout = () => reject(new MediaError("UPLOAD_TIMEOUT", "Upload timed out", undefined, true));
    xhr.onabort = () => reject(new MediaError("CANCELLED", "Upload cancelled"));
    opts.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    if (opts.signal?.aborted) return reject(new MediaError("CANCELLED", "Upload cancelled"));
    opts.onProgress?.(0, file.size);
    xhr.send(form);
  });
}

// ── register ────────────────────────────────────────────────────────────────
export async function registerWithRetry(mediaId: string, extra: { mime_type?: string; original_filename?: string } = {}): Promise<MediaAsset> {
  let last: unknown;
  for (let i = 0; i <= REGISTER_RETRIES; i++) {
    if (i > 0) await sleep(1000 * i);
    try {
      const res = await invokeEdgeFunction<{ ok: true; asset: MediaAsset }>("register-cloudinary-media", { body: { media_id: mediaId, ...extra } });
      return res.asset;
    } catch (e) {
      last = e;
      const retryable = (e instanceof EdgeFunctionError && (e.cause === "network" || e.cause === "timeout")) ||
        (e instanceof EdgeFunctionError && (e.responseBody as { retryable?: boolean } | undefined)?.retryable === true);
      if (!retryable) break;
    }
  }
  // Bytes are safely in Cloudinary; the caller can call registerMedia(mediaId) again later,
  // and cleanup-cloudinary-orphans removes it if nobody ever does.
  logWarn("media.register", "registration failed", { mediaId, code: bodyCode(last) });
  throw new MediaError("REGISTER_FAILED", "Uploaded, but couldn't be saved. Try again.", mediaId, true);
}

// ── delivery ────────────────────────────────────────────────────────────────
export interface ResolvedMedia { url: string; width: number | null; height: number | null; duration: number | null; mediaType: "image" | "video" }
const LOCAL_FIRST = new Set(["chat-files", "memories", "gallery"]);
const urlCache = new Map<string, { value: ResolvedMedia; until: number }>();
const inflight = new Map<string, Promise<ResolvedMedia | null>>();
const MAX_CACHE = 800;
let queue: Array<{ key: string; mediaId: string; variant: MediaVariant }> = [];
let timer: ReturnType<typeof setTimeout> | null = null;
const waiters = new Map<string, Array<(r: ResolvedMedia | null) => void>>();

export function forgetMediaUrls(mediaId: string): void {
  for (const k of [...urlCache.keys()]) if (k.startsWith(`${mediaId}|`)) urlCache.delete(k);
}

async function flush(): Promise<void> {
  const batch = queue; queue = []; timer = null;
  const settle = (key: string, r: ResolvedMedia | null) => { (waiters.get(key) ?? []).forEach((w) => w(r)); waiters.delete(key); };
  for (let i = 0; i < batch.length; i += 50) {
    const slice = batch.slice(i, i + 50);
    try {
      const res = await invokeEdgeFunction<{ ok: true; results: Record<string, { url?: string; cache_until?: string; width?: number; height?: number; duration?: number; media_type?: "image" | "video"; error?: string }> }>(
        "signed-cloudinary-url", { body: { items: slice.map((s) => ({ media_id: s.mediaId, variant: s.variant })) } });
      for (const s of slice) {
        const r = res.results[s.key];
        if (!r?.url) { settle(s.key, null); continue; }
        const value: ResolvedMedia = { url: r.url, width: r.width ?? null, height: r.height ?? null, duration: r.duration ?? null, mediaType: r.media_type ?? "image" };
        if (urlCache.size >= MAX_CACHE) urlCache.delete(urlCache.keys().next().value as string);
        // Cache in memory only for the server's hint (minus margin); never persisted as a URL.
        urlCache.set(s.key, { value, until: Math.min(Date.parse(r.cache_until ?? "") || Date.now() + 3600_000, Date.now() + 6 * 3600_000) - 5 * 60_000 });
        settle(s.key, value);
      }
    } catch (e) {
      logWarn("media.resolve", "signed url request failed", { code: bodyCode(e) });
      slice.forEach((s) => settle(s.key, null));
    }
  }
}

/** Signed delivery URL for one media_assets row. Null when offline-uncached, missing, deleted, or not permitted. */
export async function resolveMedia(mediaId: string, variant: MediaVariant, bucketHint?: string): Promise<ResolvedMedia | null> {
  const key = `${mediaId}|${variant}`;
  const hit = urlCache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;

  // On-device copy of the actual BYTES (images only) — works offline, stable <img src>.
  const localBucket = bucketHint && LOCAL_FIRST.has(bucketHint) && !isVideoVariant(variant) ? bucketHint : null;
  if (localBucket) {
    const local = await getLocalMediaUrl(localBucket, `cld/${mediaId}/${variant}`);
    if (local) return { url: local, width: null, height: null, duration: null, mediaType: "image" };
  }
  if (!isOnlineNow()) return null;

  const pending = inflight.get(key);
  if (pending) return pending;
  const task = new Promise<ResolvedMedia | null>((resolve) => {
    waiters.set(key, [...(waiters.get(key) ?? []), resolve]);
    queue.push({ key, mediaId, variant });
    if (!timer) timer = setTimeout(() => { void flush(); }, 15);
  }).then((r) => {
    if (r && localBucket && r.mediaType === "image") cacheMediaInBackground(localBucket, `cld/${mediaId}/${variant}`, r.url);
    return r;
  }).finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}

// ── delete ──────────────────────────────────────────────────────────────────
export async function deleteCloudinaryMedia(mediaId: string, bucketHint?: string): Promise<void> {
  if (!isOnlineNow()) throw new MediaError("OFFLINE", "You're offline", mediaId, true);
  try {
    await invokeEdgeFunction("delete-cloudinary-media", { body: { media_id: mediaId } });
  } catch (e) {
    if (e instanceof EdgeFunctionError && e.status === 404) { /* already gone / not ours: nothing to do */ }
    else throw new MediaError("DELETE_FAILED", "Couldn't delete the media", mediaId, true);
  }
  forgetMediaUrls(mediaId);
  if (bucketHint) for (const v of ["AVATAR", "CHAT_THUMBNAIL", "GALLERY_PREVIEW", "FULLSCREEN"]) void deleteLocalMedia(bucketHint, `cld/${mediaId}/${v}`);
}

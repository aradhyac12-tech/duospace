// Server-side Cloudinary Admin/Upload API calls (edge functions only).
// The API secret is read from the environment HERE and never leaves the function.
import { signApiParams, type CloudinaryResource, type ResourceType } from "./cloudinaryCore.ts";

export interface CloudinaryConfig { cloudName: string; apiKey: string; apiSecret: string }

export function loadCloudinaryConfig(): CloudinaryConfig | null {
  const cloudName = Deno.env.get("CLOUDINARY_CLOUD_NAME");
  const apiKey = Deno.env.get("CLOUDINARY_API_KEY");
  const apiSecret = Deno.env.get("CLOUDINARY_API_SECRET");
  return cloudName && apiKey && apiSecret ? { cloudName, apiKey, apiSecret } : null;
}

/** Fetch what Cloudinary REALLY stored (never trust client-reported metadata). */
export async function getAuthenticatedResource(
  cfg: CloudinaryConfig, resourceType: ResourceType, publicId: string, fetchImpl: typeof fetch = fetch,
): Promise<{ status: "ok"; resource: CloudinaryResource } | { status: "not_found" } | { status: "error"; httpStatus: number }> {
  const url = `https://api.cloudinary.com/v1_1/${cfg.cloudName}/resources/${resourceType}/authenticated/${publicId.split("/").map(encodeURIComponent).join("/")}`;
  const res = await fetchImpl(url, { headers: { Authorization: `Basic ${btoa(`${cfg.apiKey}:${cfg.apiSecret}`)}` } });
  if (res.status === 404) return { status: "not_found" };
  if (!res.ok) return { status: "error", httpStatus: res.status };
  return { status: "ok", resource: (await res.json()) as CloudinaryResource };
}

/** Destroy an authenticated asset (+ CDN invalidate). "not found" counts as success (idempotent). */
export async function destroyAuthenticatedAsset(
  cfg: CloudinaryConfig, resourceType: ResourceType, publicId: string, fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; httpStatus: number; reason: string }> {
  const timestamp = Math.floor(Date.now() / 1000);
  const params = { public_id: publicId, type: "authenticated", invalidate: "true", timestamp };
  const signature = await signApiParams(params, cfg.apiSecret);
  const form = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), api_key: cfg.apiKey, signature });
  const res = await fetchImpl(`https://api.cloudinary.com/v1_1/${cfg.cloudName}/${resourceType}/destroy`, { method: "POST", body: form });
  if (!res.ok) return { ok: false, httpStatus: res.status, reason: "http_error" };
  const body = await res.json().catch(() => ({} as { result?: string }));
  return body.result === "ok" || body.result === "not found" ? { ok: true } : { ok: false, httpStatus: res.status, reason: String(body.result ?? "unknown") };
}

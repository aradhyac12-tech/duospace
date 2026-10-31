// register-cloudinary-media — after a successful direct upload, verify with Cloudinary
// what was REALLY stored and create the media_assets row. Client-reported dimensions,
// bytes, format etc. are ignored; only media_id (+ cosmetic filename/mime) is taken.
// NOT RUNTIME-VERIFIED.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { admin, authenticate, json, limitsFromEnv, logOp } from "../_shared/mediaEdge.ts";
import { destroyAuthenticatedAsset, getAuthenticatedResource, loadCloudinaryConfig } from "../_shared/cloudinaryApi.ts";
import { folderFor, isUuid, resourceTypeForMime, sanitizeFilename, validateStoredResource } from "../_shared/cloudinaryCore.ts";

const REGISTER_WINDOW_MS = 24 * 3600 * 1000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const caller = await authenticate(req);
  if (!caller) return json(401, { ok: false, code: "UNAUTHORIZED", error: "Sign in required", retryable: false });
  const cfg = loadCloudinaryConfig();
  if (!cfg) return json(503, { ok: false, code: "NOT_CONFIGURED", error: "Media service not configured", retryable: false });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !isUuid(body.media_id)) return json(400, { ok: false, code: "INVALID_BODY", error: "media_id required", retryable: false });
  const mediaId = body.media_id;

  // Only an intent issued by THIS function to THIS user can be registered.
  const { data: intent } = await admin.from("media_upload_intents").select("*").eq("media_id", mediaId).eq("user_id", caller.userId).maybeSingle();
  if (!intent) return json(404, { ok: false, code: "NO_INTENT", error: "Unknown upload", retryable: false });

  // Idempotent: already registered -> return the existing row.
  const { data: already } = await admin.from("media_assets").select("*").eq("id", mediaId).eq("user_id", caller.userId).maybeSingle();
  if (already && already.status === "active") return json(200, { ok: true, asset: publicAsset(already), already_registered: true });
  if (Date.now() - new Date(intent.created_at).getTime() > REGISTER_WINDOW_MS) return json(410, { ok: false, code: "INTENT_EXPIRED", error: "Upload expired", retryable: false });

  const got = await getAuthenticatedResource(cfg, intent.resource_type, intent.cloudinary_public_id);
  // Not visible yet (processing/propagation) or transient Cloudinary error: the client may retry.
  if (got.status === "not_found") return json(404, { ok: false, code: "ASSET_NOT_FOUND", error: "Upload not found yet", retryable: true });
  if (got.status === "error") { logOp("register-cloudinary-media", "cloudinary_error", { mediaId, http: got.httpStatus }); return json(502, { ok: false, code: "CLOUDINARY_ERROR", error: "Media service error", retryable: true }); }

  const check = validateStoredResource(got.resource, intent, limitsFromEnv());
  if (!check.ok) {
    // Rejected content must not linger in Cloudinary.
    await destroyAuthenticatedAsset(cfg, intent.resource_type, intent.cloudinary_public_id).catch(() => {});
    await admin.from("media_upload_intents").update({ registered_at: new Date().toISOString() }).eq("media_id", mediaId);
    logOp("register-cloudinary-media", "rejected", { mediaId, code: check.code });
    return json(422, { ok: false, code: check.code, error: check.error, retryable: false });
  }

  const r = got.resource;
  const mimeIn = typeof body.mime_type === "string" ? body.mime_type.toLowerCase() : "";
  const mime = resourceTypeForMime(mimeIn) === intent.resource_type ? mimeIn : null;
  const row = {
    id: mediaId, user_id: caller.userId, scope: intent.scope,
    media_type: intent.resource_type, resource_type: intent.resource_type, delivery_type: "authenticated",
    cloudinary_public_id: intent.cloudinary_public_id, cloudinary_asset_id: r.asset_id ?? null,
    original_filename: typeof body.original_filename === "string" ? sanitizeFilename(body.original_filename) ?? null : null,
    mime_type: mime, bytes: r.bytes ?? null, width: r.width ?? null, height: r.height ?? null,
    duration: r.duration ?? null, format: r.format ?? null, folder: folderFor(caller.userId, intent.scope), status: "active",
  };
  const { data: asset, error } = await admin.from("media_assets").upsert(row, { onConflict: "id" }).select().single();
  if (error || !asset) { logOp("register-cloudinary-media", "db_failed", { mediaId }); return json(500, { ok: false, code: "DB_FAILED", error: "Could not save media", retryable: true }); }
  await admin.from("media_upload_intents").update({ registered_at: new Date().toISOString() }).eq("media_id", mediaId);
  logOp("register-cloudinary-media", "registered", { mediaId, scope: intent.scope });
  return json(200, { ok: true, asset: publicAsset(asset) });
});

// Never echo cloudinary_public_id / asset id back: clients address media by media_assets.id only.
const publicAsset = (a: Record<string, unknown>) => ({
  id: a.id, scope: a.scope, media_type: a.media_type, mime_type: a.mime_type, bytes: a.bytes,
  width: a.width, height: a.height, duration: a.duration, format: a.format, original_filename: a.original_filename, created_at: a.created_at,
});

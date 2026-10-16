// delete-cloudinary-media — the ONLY way media leaves Cloudinary. Takes a
// media_assets.id (never a public_id), checks the caller owns it, destroys the
// asset with server-side credentials, then soft-deletes the row.
// NOT RUNTIME-VERIFIED.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { admin, authenticate, json, logOp } from "../_shared/mediaEdge.ts";
import { destroyAuthenticatedAsset, loadCloudinaryConfig } from "../_shared/cloudinaryApi.ts";
import { isUuid } from "../_shared/cloudinaryCore.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const caller = await authenticate(req);
  if (!caller) return json(401, { ok: false, code: "UNAUTHORIZED", error: "Sign in required", retryable: false });
  const cfg = loadCloudinaryConfig();
  if (!cfg) return json(503, { ok: false, code: "NOT_CONFIGURED", error: "Media service not configured", retryable: false });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !isUuid(body.media_id)) return json(400, { ok: false, code: "INVALID_BODY", error: "media_id required", retryable: false });

  const { data: asset } = await admin.from("media_assets").select("id,user_id,resource_type,cloudinary_public_id,status").eq("id", body.media_id).maybeSingle();
  // Same answer for "missing" and "not yours": do not reveal other users' ids.
  if (!asset || asset.user_id !== caller.userId) return json(404, { ok: false, code: "NOT_FOUND", error: "Media not found", retryable: false });
  if (asset.status === "deleted") return json(200, { ok: true, already_deleted: true });

  await admin.from("media_assets").update({ status: "deleting" }).eq("id", asset.id);
  const res = await destroyAuthenticatedAsset(cfg, asset.resource_type, asset.cloudinary_public_id);
  if (!res.ok) {
    // Keep the row (status delete_failed) so the delete can be retried; never claim success.
    await admin.from("media_assets").update({ status: "delete_failed" }).eq("id", asset.id);
    logOp("delete-cloudinary-media", "cloudinary_failed", { mediaId: asset.id, http: res.httpStatus, reason: res.reason });
    return json(502, { ok: false, code: "CLOUDINARY_DELETE_FAILED", error: "Could not delete media yet", retryable: true });
  }
  const { error } = await admin.from("media_assets").update({ status: "deleted", deleted_at: new Date().toISOString() }).eq("id", asset.id);
  if (error) { logOp("delete-cloudinary-media", "db_failed", { mediaId: asset.id }); return json(500, { ok: false, code: "DB_FAILED", error: "Deleted, but could not record it", retryable: true }); }
  logOp("delete-cloudinary-media", "deleted", { mediaId: asset.id });
  return json(200, { ok: true });
});

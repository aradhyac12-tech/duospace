// sign-cloudinary-upload — authorizes ONE direct-to-Cloudinary upload.
// The binary never touches Supabase: client -> Cloudinary. This function only
// (1) authenticates, (2) validates the request, (3) derives the folder/public_id
// from the caller's own identity, (4) records an upload intent, (5) signs.
// NOT RUNTIME-VERIFIED (no deploy access from the authoring environment).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { consumeRateLimit } from "../_shared/rateLimit.ts";
import { admin, authenticate, json, limitsFromEnv, logOp } from "../_shared/mediaEdge.ts";
import { loadCloudinaryConfig } from "../_shared/cloudinaryApi.ts";
import { buildUploadAuthorization, publicIdFor, validateSignRequest } from "../_shared/cloudinaryCore.ts";

const SIGNATURE_TTL_SECONDS = 3600; // Cloudinary itself rejects timestamps older than ~1h.

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, code: "METHOD", error: "POST only" });

  const caller = await authenticate(req);
  if (!caller) return json(401, { ok: false, code: "UNAUTHORIZED", error: "Sign in required", retryable: false });

  const cfg = loadCloudinaryConfig();
  if (!cfg) { logOp("sign-cloudinary-upload", "config_missing"); return json(503, { ok: false, code: "NOT_CONFIGURED", error: "Media service not configured", retryable: false }); }

  const body = await req.json().catch(() => null);
  const v = validateSignRequest(body, limitsFromEnv());
  if (!v.ok) return json(400, { ok: false, code: v.code, error: v.error, retryable: false });
  const { scope, mime, resourceType, bytes, clientUploadId } = v.value;

  if (!(await consumeRateLimit(caller.userId, "cloudinary-sign", 120, 3600))) {
    return json(429, { ok: false, code: "RATE_LIMITED", error: "Too many uploads, try again shortly", retryable: true });
  }

  // Chat media only makes sense with a linked partner (existing partner model).
  if (scope === "chat") {
    const { data: prof } = await admin.from("profiles").select("partner_id").eq("user_id", caller.userId).maybeSingle();
    if (!prof?.partner_id) return json(403, { ok: false, code: "NO_PARTNER", error: "Link a partner first", retryable: false });
  }

  const mediaId = clientUploadId ?? crypto.randomUUID();
  const publicId = publicIdFor(caller.userId, scope, mediaId);

  // Idempotent re-sign for retries of the same client_upload_id (same user only).
  const { data: existing } = await admin.from("media_upload_intents").select("user_id,scope,resource_type").eq("media_id", mediaId).maybeSingle();
  if (existing && (existing.user_id !== caller.userId || existing.scope !== scope || existing.resource_type !== resourceType)) {
    return json(409, { ok: false, code: "ID_IN_USE", error: "Upload id already used", retryable: false });
  }
  const now = Math.floor(Date.now() / 1000);
  const maxBytes = resourceType === "image" ? limitsFromEnv().maxImageBytes : limitsFromEnv().maxVideoBytes;
  const { error: intentErr } = await admin.from("media_upload_intents").upsert({
    media_id: mediaId, user_id: caller.userId, scope, resource_type: resourceType,
    cloudinary_public_id: publicId, max_bytes: maxBytes,
    expires_at: new Date((now + SIGNATURE_TTL_SECONDS) * 1000).toISOString(),
  }, { onConflict: "media_id" });
  if (intentErr) { logOp("sign-cloudinary-upload", "intent_failed", { scope }); return json(500, { ok: false, code: "INTERNAL", error: "Could not start upload", retryable: true }); }

  const auth = await buildUploadAuthorization(cfg, { publicId, resourceType, nowSeconds: now });
  logOp("sign-cloudinary-upload", "signed", { mediaId, scope, resourceType, mime });
  // Only what the client needs. No secret, no folder choice.
  return json(200, { ok: true, media_id: mediaId, ...auth, expires_in: SIGNATURE_TTL_SECONDS });
});

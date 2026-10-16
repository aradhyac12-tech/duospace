// signed-cloudinary-url — mints signed authenticated delivery URLs on demand.
// Authorization is the table's own RLS (the lookup runs as the CALLER), so the
// owner/partner/gallery-visibility rules live in exactly one place (the policy).
// Accepts up to 50 {media_id, variant} items per call to keep round trips low.
// NOT RUNTIME-VERIFIED.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { authenticate, json } from "../_shared/mediaEdge.ts";
import { loadCloudinaryConfig } from "../_shared/cloudinaryApi.ts";
import { adaptVariant, buildSignedDeliveryUrl, isUuid, isVariantName, VARIANTS } from "../_shared/cloudinaryCore.ts";

const MAX_ITEMS = 50;
// How long a client should keep a URL before asking again. NOTE: this is a cache hint,
// not a hard expiry — plain signed authenticated URLs do not expire (see docs).
const CACHE_HINT_SECONDS = 6 * 3600;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const caller = await authenticate(req);
  if (!caller) return json(401, { ok: false, code: "UNAUTHORIZED", error: "Sign in required", retryable: false });
  const cfg = loadCloudinaryConfig();
  if (!cfg) return json(503, { ok: false, code: "NOT_CONFIGURED", error: "Media service not configured", retryable: false });

  const body = (await req.json().catch(() => null)) as { items?: unknown } | null;
  const items = Array.isArray(body?.items) ? (body!.items as Array<Record<string, unknown>>).slice(0, MAX_ITEMS) : [];
  if (!items.length) return json(400, { ok: false, code: "INVALID_BODY", error: "items required", retryable: false });

  const wanted = items.filter((i) => isUuid(i?.media_id) && isVariantName(i?.variant));
  const ids = [...new Set(wanted.map((i) => i.media_id as string))];
  // RLS-filtered read: rows the caller may not see simply do not come back.
  const { data: rows, error } = ids.length
    ? await caller.asUser.from("media_assets").select("id,resource_type,cloudinary_public_id,width,height,duration,media_type").in("id", ids)
    : { data: [], error: null };
  if (error) return json(500, { ok: false, code: "INTERNAL", error: "Lookup failed", retryable: true });
  const byId = new Map((rows ?? []).map((r) => [r.id as string, r]));

  const results: Record<string, unknown> = {};
  for (const it of items) {
    const key = `${it?.media_id}|${it?.variant}`;
    if (!isUuid(it?.media_id) || !isVariantName(it?.variant)) { results[key] = { error: "INVALID_ITEM" }; continue; }
    const row = byId.get(it.media_id);
    if (!row) { results[key] = { error: "NOT_FOUND" }; continue; } // missing, deleted, or not yours: indistinguishable
    const variant = adaptVariant(it.variant, row.resource_type);
    if (VARIANTS[variant].resource !== row.resource_type) { results[key] = { error: "VARIANT_MISMATCH" }; continue; }
    results[key] = {
      url: await buildSignedDeliveryUrl(cfg, { publicId: row.cloudinary_public_id, resourceType: row.resource_type, variant }),
      cache_until: new Date(Date.now() + CACHE_HINT_SECONDS * 1000).toISOString(),
      width: row.width, height: row.height, duration: row.duration, media_type: row.media_type,
    };
  }
  return json(200, { ok: true, results });
});

// cleanup-cloudinary-orphans — cron-friendly sweeper for the "Cloudinary succeeded,
// registration never happened" case. Intents unregistered >24h after creation are
// destroyed in Cloudinary and removed. Same cron auth as the other cron functions.
// NOT RUNTIME-VERIFIED. Schedule it like cleanup-orphan-uploads.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { authenticateCronRequest } from "../_shared/cron-auth.ts";
import { admin, json, logOp } from "../_shared/mediaEdge.ts";
import { destroyAuthenticatedAsset, loadCloudinaryConfig } from "../_shared/cloudinaryApi.ts";

Deno.serve(async (req) => {
  const denied = authenticateCronRequest(req);
  if (denied) return denied;
  const cfg = loadCloudinaryConfig();
  if (!cfg) return json(503, { ok: false, code: "NOT_CONFIGURED" });
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: stale } = await admin.from("media_upload_intents").select("media_id,resource_type,cloudinary_public_id")
    .is("registered_at", null).lt("created_at", cutoff).limit(100);
  let removed = 0, failed = 0;
  for (const i of stale ?? []) {
    const r = await destroyAuthenticatedAsset(cfg, i.resource_type, i.cloudinary_public_id);
    if (r.ok) { await admin.from("media_upload_intents").delete().eq("media_id", i.media_id); removed++; } else failed++;
  }
  logOp("cleanup-cloudinary-orphans", "sweep", { removed, failed });
  return json(200, { ok: true, removed, failed });
});

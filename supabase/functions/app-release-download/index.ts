// Edge Function: app-release-download
//
// Turns a PUBLISHED app_releases row into something the app can download:
//   android  -> { kind: "apk",     url: <signed storage URL, 6h>, file_name, sha256, size }
//   ios+file -> { kind: "ios-ota", url: itms-services://... (points at app-release-ios-manifest) }
//   ios+link -> { kind: "external", url: <App Store / TestFlight link> }
//
// Callable WITHOUT a user session (verify_jwt = false in config.toml): an update
// may be exactly what repairs a broken sign-in. It only ever serves releases an
// ADMIN published; drafts/revoked rows and the storage path are unreachable.
// Uploading/publishing is admin-only and enforced in Postgres, not here.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { releaseFileName, signManifestLink, UUID_RE } from "../_shared/appRelease.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// A paused DownloadManager job (waiting for Wi-Fi) keeps the same URL, so give
// it a long life; the app asks again if the download fails.
const APK_URL_TTL_SECONDS = 6 * 60 * 60;
const MANIFEST_LINK_TTL_SECONDS = 10 * 60;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let releaseId = "";
  try {
    const body = await req.json();
    releaseId = typeof body?.release_id === "string" ? body.release_id : "";
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (!UUID_RE.test(releaseId)) return json({ error: "release_id required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data: rel, error } = await admin
    .from("app_releases")
    .select("id, platform, version_name, version_code, status, file_path, file_size_bytes, sha256, external_url")
    .eq("id", releaseId)
    .maybeSingle();

  if (error) {
    console.error("[app-release-download] lookup failed:", error.message);
    return json({ error: "Lookup failed" }, 500);
  }
  // Same answer for "missing" and "not published" so drafts can't be probed.
  if (!rel || rel.status !== "published") return json({ error: "Release not available" }, 404);

  if (rel.platform === "ios" && !rel.file_path && rel.external_url) {
    return json({ kind: "external", url: rel.external_url });
  }
  if (!rel.file_path) return json({ error: "Release has no file" }, 404);

  if (rel.platform === "android") {
    const { data: signed, error: signErr } = await admin.storage
      .from("app-releases")
      .createSignedUrl(rel.file_path, APK_URL_TTL_SECONDS);
    if (signErr || !signed?.signedUrl) {
      console.error("[app-release-download] sign failed:", signErr?.message);
      return json({ error: "Could not prepare download" }, 500);
    }
    return json({
      kind: "apk",
      url: signed.signedUrl,
      file_name: releaseFileName("android", rel.version_name, rel.version_code),
      sha256: rel.sha256,
      size: rel.file_size_bytes,
    });
  }

  // iOS over-the-air install: itms-services needs an HTTPS manifest plist.
  const exp = Math.floor(Date.now() / 1000) + MANIFEST_LINK_TTL_SECONDS;
  const sig = await signManifestLink(SERVICE_KEY, rel.id, exp);
  const manifestUrl =
    `${SUPABASE_URL}/functions/v1/app-release-ios-manifest?rid=${rel.id}&exp=${exp}&sig=${sig}`;
  return json({
    kind: "ios-ota",
    url: `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`,
  });
});

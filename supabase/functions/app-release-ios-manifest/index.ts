// Edge Function: app-release-ios-manifest
//
// Serves the manifest.plist that iOS's itms-services installer fetches. iOS
// cannot send credentials, so access is an HMAC-signed link (10 min) minted by
// app-release-download. The IPA URL inside is itself a short-lived signed
// storage URL; the bucket stays private.
//
// itms-services only installs IPAs signed for the target device (ad-hoc,
// enterprise or development provisioning). It cannot install an App Store /
// TestFlight build — for those, publish the release with external_url instead.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { iosManifestPlist, UUID_RE, verifyManifestLink } from "../_shared/appRelease.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUNDLE_ID = Deno.env.get("APP_BUNDLE_ID") ?? "com.duospace.app";
const IPA_URL_TTL_SECONDS = 60 * 60;

function plain(status: number, msg: string): Response {
  return new Response(msg, { status, headers: { "Content-Type": "text/plain" } });
}

Deno.serve(async (req) => {
  if (req.method !== "GET") return plain(405, "Method not allowed");

  const url = new URL(req.url);
  const rid = url.searchParams.get("rid") ?? "";
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") ?? "";

  if (!UUID_RE.test(rid) || !(await verifyManifestLink(SERVICE_KEY, rid, exp, sig))) {
    return plain(403, "Invalid or expired link");
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data: rel } = await admin
    .from("app_releases")
    .select("platform, version_name, status, file_path")
    .eq("id", rid)
    .maybeSingle();

  if (!rel || rel.status !== "published" || rel.platform !== "ios" || !rel.file_path) {
    return plain(404, "Release not available");
  }

  const { data: signed, error } = await admin.storage
    .from("app-releases")
    .createSignedUrl(rel.file_path, IPA_URL_TTL_SECONDS);
  if (error || !signed?.signedUrl) return plain(500, "Could not prepare download");

  const plist = iosManifestPlist({
    ipaUrl: signed.signedUrl,
    bundleId: BUNDLE_ID,
    versionName: rel.version_name,
    title: "DuoSpace",
  });
  return new Response(plist, {
    status: 200,
    headers: { "Content-Type": "text/xml; charset=utf-8", "Cache-Control": "no-store" },
  });
});

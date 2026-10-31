/**
 * location-push-upload — accepts ONE location fix from a device that holds a
 * `location-push-register` credential and writes it to that user's row in
 * `locations`. This is what lets the map stay fresh when a text/call push
 * arrives while the app is closed (KI-12 gap 2).
 *
 * verify_jwt = false ON PURPOSE: the caller is a dead app process with no
 * usable session. Authentication is the (credential_id, secret) pair, compared
 * as SHA-256 hashes in constant time. The credential can do nothing except
 * this one write, for its own user only.
 *
 * Abuse limits: a credential can upload at most once every 2 s; coordinates
 * must be valid; the fix's capture time must be within the last 10 min and no
 * more than 2 min in the future. Every auth failure returns the same generic
 * 401 so credential ids can't be probed. The `locations` monotonic write guard
 * trigger still decides whether the fix is newer than what is stored.
 *
 * The body may also carry battery_level / battery_charging / ringer_mode; a
 * body with ONLY those (no fix) is a valid status-only upload, used when a push
 * arrives but no GPS fix could be obtained.
 *
 * NOT RUNTIME-VERIFIED end to end from a real device.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MIN_INTERVAL_MS = 2_000; // was 8 s: a watcher upload just before a push fix made the push fix 429
const MAX_AGE_MS = 10 * 60 * 1000;
const MAX_FUTURE_MS = 2 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }

  const credentialId = typeof b.credential_id === "string" ? b.credential_id : "";
  const secret = typeof b.secret === "string" ? b.secret : "";
  const hasFix = b.latitude !== undefined || b.longitude !== undefined || b.captured_at_ms !== undefined;
  const lat = typeof b.latitude === "number" ? b.latitude : NaN;
  const lng = typeof b.longitude === "number" ? b.longitude : NaN;
  const capturedMs = typeof b.captured_at_ms === "number" ? b.captured_at_ms : NaN;

  // Optional device status (battery/ringer) — lets a push refresh the partner's
  // battery chip even when no GPS fix could be obtained (status-only upload).
  const battery = typeof b.battery_level === "number" && b.battery_level >= 0 && b.battery_level <= 100
    ? Math.round(b.battery_level * 10) / 10 : null;
  const charging = typeof b.battery_charging === "boolean" ? b.battery_charging : null;
  const ringer = typeof b.ringer_mode === "string" && ["normal", "vibrate", "silent", "unknown"].includes(b.ringer_mode)
    ? b.ringer_mode : null;
  const hasStatus = battery !== null || charging !== null || ringer !== null;

  if (!UUID_RE.test(credentialId) || secret.length < 20 || secret.length > 200) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }
  if (!hasFix && !hasStatus) return json({ ok: false, error: "Nothing to upload" }, 400);
  const now = Date.now();
  if (hasFix) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return json({ ok: false, error: "Invalid coordinates" }, 400);
    }
    if (!Number.isFinite(capturedMs) || capturedMs < now - MAX_AGE_MS || capturedMs > now + MAX_FUTURE_MS) {
      return json({ ok: false, error: "Fix timestamp out of range" }, 422);
    }
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: cred } = await admin
    .from("location_push_credentials")
    .select("id, user_id, secret_hash, last_used_at")
    .eq("id", credentialId)
    .maybeSingle();

  const presented = await sha256Hex(secret);
  if (!cred || !timingSafeEqual(presented, cred.secret_hash)) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  if (cred.last_used_at && now - new Date(cred.last_used_at).getTime() < MIN_INTERVAL_MS) {
    return json({ ok: false, error: "Too many requests" }, 429);
  }

  const { error: touchErr } = await admin
    .from("location_push_credentials")
    .update({ last_used_at: new Date(now).toISOString() })
    .eq("id", cred.id);
  if (touchErr) return json({ ok: false, error: "Server error" }, 500);

  if (hasFix) {
    const { error: upErr } = await admin
      .from("locations")
      .upsert(
        { user_id: cred.user_id, latitude: lat, longitude: lng, captured_at: new Date(capturedMs).toISOString() },
        { onConflict: "user_id" },
      );
    if (upErr) return json({ ok: false, error: "Server error" }, 500);
  }

  if (hasStatus) {
    const patch: Record<string, unknown> = { device_status_updated_at: new Date(now).toISOString() };
    if (battery !== null) patch.battery_level = battery;
    if (charging !== null) patch.battery_charging = charging;
    if (ringer !== null) patch.ringer_mode = ringer;
    // Non-fatal: a failed status write must not fail a location that already landed.
    const { error: stErr } = await admin.from("profiles").update(patch).eq("user_id", cred.user_id);
    if (stErr && !hasFix) return json({ ok: false, error: "Server error" }, 500);
  }

  return json({ ok: true });
});

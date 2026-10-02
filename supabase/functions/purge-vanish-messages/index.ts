// Edge Function: purge-vanish-messages
//
// Server half of Vanish Mode cleanup. Deletes vanish messages AND the
// photo / video / file / voice-note behind them, including files the PARTNER
// uploaded — something a client can't do, because storage RLS on the
// chat-files bucket only lets a user delete objects in their own folder.
//
// Body: { mode: "end_session" | "sweep_seen" }
//
//   end_session — the caller turned Vanish Mode off.
//     • every SEEN vanish message (is_read = true), both directions, is
//       deleted with its file;
//     • an UNSEEN message is never deleted. The caller's own unseen messages
//       are re-labelled "vanish_after_seen" (kept for the partner to read,
//       deleted once they have); the partner's unseen messages belong to
//       their own session and are left alone;
//     • a "vanish_after_seen" message goes only if the caller is its reader.
//
//   sweep_seen — the caller left the chat / opened it fresh: delete the
//     "vanish_after_seen" messages the caller has now read.
//
// These are the same rules as src/lib/vanishPlan.ts — keep them in sync.
//
// SECURITY: runs with the service role, so it never trusts a row's file_url
// blindly. A file is removed only if (a) the row is a vanish message between
// the caller and their linked partner, and (b) the object lives in the
// folder of the row's own sender. Without (b), someone could insert a vanish
// message whose file_url points at another user's file and have this
// function delete it.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// CORS headers inlined (same as ../_shared/cors.ts) so this function deploys as
// a single self-contained file, e.g. through the Supabase dashboard / MCP.
const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = (Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY"))!;

const BUCKET = "chat-files";
const VANISH = "vanish";
const AFTER_SEEN = "vanish_after_seen";
const BATCH = 100;

interface Row {
  id: string;
  sender_id: string;
  receiver_id: string;
  file_url: string | null;
  is_read: boolean;
  disappear_at: string | null;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Path exactly as it appears in file_url (percent-encoded) — what clients key their caches on. */
function encodedPath(fileUrl: string | null): string | null {
  if (!fileUrl) return null;
  const marker = `/${BUCKET}/`;
  const idx = fileUrl.indexOf(marker);
  if (idx === -1) return null;
  return fileUrl.slice(idx + marker.length).split("?")[0] || null;
}

/** The object's real (decoded) name, or null if it isn't safe to delete. */
function safeObjectName(row: Row): string | null {
  const enc = encodedPath(row.file_url);
  if (!enc) return null;
  let name: string;
  try { name = decodeURIComponent(enc); } catch { name = enc; }
  const segments = name.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..") || name.includes("\0")) return null;
  // The object must sit in the uploader's own folder.
  if (segments[0] !== row.sender_id) return null;
  return name;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json(401, { ok: false, error: "Missing Authorization header" });

    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) return json(401, { ok: false, error: "Invalid or expired session" });

    const body = await req.json().catch(() => ({}));
    const mode = body?.mode;
    if (mode !== "end_session" && mode !== "sweep_seen") {
      return json(400, { ok: false, error: "mode must be end_session or sweep_seen" });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const { data: profile, error: profErr } = await admin
      .from("profiles").select("partner_id").eq("user_id", user.id).maybeSingle();
    if (profErr) return json(500, { ok: false, error: profErr.message });
    const partnerId = profile?.partner_id as string | null | undefined;
    if (!partnerId) return json(200, { ok: true, deleted: [], keptUnseen: 0 });

    const me = user.id;
    const conv =
      `and(sender_id.eq.${me},receiver_id.eq.${partnerId}),` +
      `and(sender_id.eq.${partnerId},receiver_id.eq.${me})`;
    const { data: rows, error: rowsErr } = await admin
      .from("messages")
      .select("id,sender_id,receiver_id,file_url,is_read,disappear_at")
      .in("disappear_at", [VANISH, AFTER_SEEN])
      .or(conv);
    if (rowsErr) return json(500, { ok: false, error: rowsErr.message });

    // ── plan (mirror of src/lib/vanishPlan.ts) ──────────────────────────
    const toDelete: Row[] = [];
    const toMarkAfterSeen: string[] = [];
    for (const r of (rows ?? []) as Row[]) {
      if (mode === "end_session" && r.disappear_at === VANISH) {
        if (r.is_read) toDelete.push(r);
        else if (r.sender_id === me) toMarkAfterSeen.push(r.id);
      } else if (r.disappear_at === AFTER_SEEN && r.is_read && r.receiver_id === me) {
        toDelete.push(r);
      }
    }

    // ── files first, then rows ──────────────────────────────────────────
    // A row is only deleted once its file is gone (or it never had one). If
    // storage errors, the row stays and the next sweep retries — better than
    // silently orphaning a file nobody can reach any more.
    const deleted: { id: string; path: string | null }[] = [];
    for (let i = 0; i < toDelete.length; i += BATCH) {
      const batch = toDelete.slice(i, i + BATCH);
      const names = batch.map(safeObjectName).filter((n): n is string => !!n);
      if (names.length > 0) {
        const { error: rmErr } = await admin.storage.from(BUCKET).remove(names);
        if (rmErr) {
          console.error("[purge-vanish-messages] storage remove failed:", rmErr.message);
          // Keep rows that have a file we failed to remove; rows without one can still go.
          const withFile = new Set(batch.filter((r) => safeObjectName(r)).map((r) => r.id));
          const okRows = batch.filter((r) => !withFile.has(r.id));
          if (okRows.length > 0) {
            const { error: delErr } = await admin.from("messages").delete().in("id", okRows.map((r) => r.id));
            if (!delErr) okRows.forEach((r) => deleted.push({ id: r.id, path: encodedPath(r.file_url) }));
          }
          continue;
        }
      }
      const { error: delErr } = await admin.from("messages").delete().in("id", batch.map((r) => r.id));
      if (delErr) {
        console.error("[purge-vanish-messages] row delete failed:", delErr.message);
        continue;
      }
      batch.forEach((r) => deleted.push({ id: r.id, path: encodedPath(r.file_url) }));
    }

    // ── keep-but-relabel the caller's unseen messages ───────────────────
    let keptUnseen = 0;
    for (let i = 0; i < toMarkAfterSeen.length; i += BATCH) {
      const ids = toMarkAfterSeen.slice(i, i + BATCH);
      const { error: updErr } = await admin
        .from("messages").update({ disappear_at: AFTER_SEEN }).in("id", ids).eq("sender_id", me).eq("is_read", false);
      if (updErr) console.error("[purge-vanish-messages] relabel failed:", updErr.message);
      else keptUnseen += ids.length;
    }

    return json(200, { ok: true, deleted, keptUnseen });
  } catch (err) {
    console.error("[purge-vanish-messages] unexpected:", err);
    return json(500, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

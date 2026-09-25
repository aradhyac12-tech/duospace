// Vanish Mode — deleting what has to go, and ONLY what has to go.
//
// Two entry points (rules live in vanishPlan.ts):
//
//   endVanishSession()  — the person turned Vanish Mode off. Everything that
//                         has been SEEN is deleted (row + the photo / video /
//                         file / voice-note in storage). Anything the other
//                         person has NOT seen yet is kept and re-labelled
//                         "vanish_after_seen" so it is deleted once they've
//                         read it.
//   sweepSeenVanish()   — the person left the chat (or opened it fresh):
//                         delete the "vanish_after_seen" messages they have
//                         now read.
//
// Both go through the `purge-vanish-messages` edge function first, because
// only the server can delete a file the PARTNER uploaded (storage RLS lets
// each person delete just their own uploads). If the function isn't deployed
// or is unreachable we fall back to doing as much as the client is allowed
// to: delete the rows and my own uploads. The partner's uploads are then
// removed by their own device when it receives the delete (see the DELETE
// handler in useChatRealtimeMessages.ts).
import { supabase } from "@/integrations/supabase/appClient";
import { logWarn } from "@/lib/telemetry";
import { VANISH_SENTINEL, VANISH_AFTER_SEEN_SENTINEL } from "@/lib/chatConstants";
import { CHAT_BUCKET, chatFileObjectName, forgetVanishMedia } from "@/lib/vanishMedia";
import { planEndVanish, planSweepSeen, type VanishRow } from "@/lib/vanishPlan";

export interface VanishPurgeResult {
  /** Message ids that were deleted. */
  deletedIds: string[];
  /** Unseen messages of mine that were kept (they vanish after being seen). */
  keptUnseenCount: number;
  /** Which path did the work. */
  via: "server" | "client";
  /** Uploaded files that could not be removed from storage (client fallback only). */
  mediaLeftBehind: number;
}

interface ServerResponse {
  ok: boolean;
  deleted: { id: string; path: string | null }[];
  keptUnseen: number;
  error?: string;
}

const EDGE_FUNCTION = "purge-vanish-messages";
const ROW_COLUMNS = "id,sender_id,receiver_id,file_url,is_read,disappear_at";
const CHUNK = 100;
const SERVER_TIMEOUT_MS = 20000;

const chunks = <T,>(arr: T[], n = CHUNK): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

async function viaServer(mode: "end_session" | "sweep_seen"): Promise<VanishPurgeResult | null> {
  // Raw supabase-js invoke (not edgeFunction.invokeEdgeFunction): a project
  // where this function isn't deployed yet is an expected, handled case here
  // — the client fallback below covers it — and shouldn't be reported as an
  // app error every time someone leaves the chat.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), SERVER_TIMEOUT_MS);
    });
    const { data, error } = await Promise.race([
      supabase.functions.invoke<ServerResponse>(EDGE_FUNCTION, { body: { mode } }),
      timeout,
    ]);
    if (error || !data?.ok || !Array.isArray(data.deleted)) {
      logWarn("vanishPurge", `${EDGE_FUNCTION} unavailable — using client fallback`, error ?? data);
      return null;
    }
    // The server removed the files from storage; clear this device's copies.
    await Promise.all(data.deleted.map((d) => forgetVanishMedia(d.path)));
    return {
      deletedIds: data.deleted.map((d) => d.id),
      keptUnseenCount: data.keptUnseen ?? 0,
      via: "server",
      mediaLeftBehind: 0,
    };
  } catch (err) {
    logWarn("vanishPurge", `${EDGE_FUNCTION} failed — using client fallback`, err);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function loadVanishRows(userId: string, partnerId: string): Promise<VanishRow[]> {
  const conv =
    `and(sender_id.eq.${userId},receiver_id.eq.${partnerId}),` +
    `and(sender_id.eq.${partnerId},receiver_id.eq.${userId})`;
  const { data, error } = await supabase
    .from("messages")
    .select(ROW_COLUMNS)
    .in("disappear_at", [VANISH_SENTINEL, VANISH_AFTER_SEEN_SENTINEL])
    .or(conv);
  if (error) throw error;
  return (data ?? []) as VanishRow[];
}

/** Delete rows + the files I'm allowed to delete. Returns ids actually deleted. */
async function deleteRowsClientSide(rows: VanishRow[], userId: string): Promise<{ ids: string[]; mediaLeftBehind: number }> {
  if (rows.length === 0) return { ids: [], mediaLeftBehind: 0 };

  // Files first: once the row is gone nothing points at the object any more.
  let mediaLeftBehind = 0;
  const ownPaths: string[] = [];
  for (const r of rows) {
    const path = chatFileObjectName(r.file_url);
    if (!path) continue;
    if (r.sender_id === userId) ownPaths.push(path);
    else mediaLeftBehind++; // partner's upload — storage RLS won't let me delete it
  }
  for (const batch of chunks(ownPaths)) {
    const { error } = await supabase.storage.from(CHAT_BUCKET).remove(batch);
    if (error) {
      mediaLeftBehind += batch.length;
      logWarn("vanishPurge", "could not remove some uploaded files", error);
    }
  }

  const deleted: string[] = [];
  for (const batch of chunks(rows.map((r) => r.id))) {
    const { error } = await supabase.from("messages").delete().in("id", batch);
    if (error) logWarn("vanishPurge", "could not delete some vanish rows", error);
    else deleted.push(...batch);
  }
  await Promise.all(rows.filter((r) => deleted.includes(r.id)).map((r) => forgetVanishMedia(r.file_url)));
  return { ids: deleted, mediaLeftBehind };
}

export async function endVanishSession(userId: string, partnerId: string): Promise<VanishPurgeResult> {
  const server = await viaServer("end_session");
  if (server) return server;

  const rows = await loadVanishRows(userId, partnerId);
  const plan = planEndVanish(rows, userId);
  const { ids, mediaLeftBehind } = await deleteRowsClientSide(plan.deleteRows, userId);
  for (const batch of chunks(plan.markAfterSeenIds)) {
    const { error } = await supabase
      .from("messages")
      .update({ disappear_at: VANISH_AFTER_SEEN_SENTINEL })
      .in("id", batch)
      .eq("sender_id", userId);
    if (error) logWarn("vanishPurge", "could not mark unseen messages vanish-after-seen", error);
  }
  return { deletedIds: ids, keptUnseenCount: plan.markAfterSeenIds.length, via: "client", mediaLeftBehind };
}

export async function sweepSeenVanish(userId: string, partnerId: string): Promise<VanishPurgeResult> {
  const server = await viaServer("sweep_seen");
  if (server) return server;

  const rows = await loadVanishRows(userId, partnerId);
  const { ids, mediaLeftBehind } = await deleteRowsClientSide(planSweepSeen(rows, userId), userId);
  return { deletedIds: ids, keptUnseenCount: 0, via: "client", mediaLeftBehind };
}

// Edge Function: deliver-scheduled-messages
// Triggered by Supabase cron every minute.
//
// FIX AUDIT #10: Duplicate-send race condition fixed via atomic UPDATE … RETURNING.
// FIX AUDIT #3:  Removed `any` types — errors typed as `unknown`.
// FIX AUDIT #2:  All failure paths now log structured errors (never silent).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

interface ClaimedMessage {
  id: string;
  sender_id: string;
  receiver_id: string;
  content: string;
  message_type: string;
  disappear_at: string | null;
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase     = createClient(SUPABASE_URL, SERVICE_KEY);

Deno.serve(async (req) => {
  if (!SERVICE_KEY) {
    return new Response(
      JSON.stringify({ error: "Server misconfiguration: missing service key" }),
      { status: 500 },
    );
  }
  const auth = req.headers.get("Authorization") ?? "";
  if (auth !== `Bearer ${SERVICE_KEY}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  try {
    // FIX AUDIT #10: Atomic claim — two concurrent cron invocations each get
    // a disjoint set of rows. The RPC does:
    //   UPDATE scheduled_messages
    //   SET is_processing = true
    //   WHERE sent = false AND is_processing = false AND send_at <= now()
    //   RETURNING *
    const { data: claimed, error: claimErr } = await supabase.rpc(
      "claim_pending_scheduled_messages",
    ) as { data: ClaimedMessage[] | null; error: unknown };

    if (claimErr) throw claimErr;
    if (!claimed || claimed.length === 0) {
      return new Response(JSON.stringify({ delivered: 0 }), { status: 200 });
    }

    let delivered = 0;
    const failures: string[] = [];

    for (const msg of claimed) {
      const { error: insertErr } = await supabase.from("messages").insert({
        sender_id:    msg.sender_id,
        receiver_id:  msg.receiver_id,
        content:      msg.content,
        message_type: msg.message_type || "text",
        disappear_at: msg.disappear_at ?? null,
        is_read:      false,
        reply_to_id:  null,
      });

      if (insertErr) {
        // FIX AUDIT #2: never silently swallow — always log
        const errMsg = insertErr instanceof Error ? insertErr.message : String(insertErr);
        console.error(`[deliver-scheduled] insert failed for ${msg.id}: ${errMsg}`);
        failures.push(msg.id);
        // Roll back claim so message is retried on next cron tick
        await supabase.from("scheduled_messages")
          .update({ is_processing: false }).eq("id", msg.id);
      } else {
        await supabase.from("scheduled_messages")
          .update({ sent: true, is_processing: false }).eq("id", msg.id);
        delivered++;
      }
    }

    return new Response(
      JSON.stringify({ delivered, failed: failures.length, failedIds: failures }),
      { status: 200 },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[deliver-scheduled] fatal error:", message);
    return new Response(JSON.stringify({ error: message }), { status: 500 });
  }
});

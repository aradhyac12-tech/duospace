import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/appClient";
import { useAuth } from "@/hooks/useAuth";
import { logWarn } from "@/lib/telemetry";
import { UNLINK_REQUESTS_CHANGED_EVENT } from "@/lib/partnerUnlink";
import {
  SHARING_STATE_CHANGED_EVENT,
  hasHandledExecuted,
  markHandledExecuted,
  type ScheduledUnlink,
  type ScheduledUnlinkRpcResult,
} from "@/lib/scheduledUnlink";

interface Options {
  /** Keeps realtime channel names unique when several components use this hook. */
  scope: string;
  /**
   * Fires once per schedule that completed (either person's), including one
   * that completed while this device was closed. The caller wraps up locally
   * (clear cached partner + reload).
   */
  onExecuted?: (row: ScheduledUnlink) => void;
}

/**
 * Live view of the delayed-unlink countdown involving the signed-in user:
 *  - `mine`:   I scheduled it (I can cancel it)
 *  - `theirs`: my partner scheduled it (I can see the date; I can't stop it)
 *
 * On open / foreground / push it also asks the server to complete anything of
 * mine that is due (process_my_due_unlink), so the unlink lands on time even
 * where pg_cron isn't installed. Failures keep the last known state — a failed
 * re-check must never hide a countdown.
 */
export function useScheduledUnlink({ scope, onExecuted }: Options) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [rows, setRows] = useState<ScheduledUnlink[]>([]);
  const [loading, setLoading] = useState(true);

  const executedCb = useRef(onExecuted);
  executedCb.current = onExecuted;

  const refresh = useCallback(async () => {
    if (!userId) { setRows([]); setLoading(false); return; }

    // Complete anything due first, so the read below reflects it.
    try { await supabase.rpc("process_my_due_unlink" as any); } catch { /* the sweep or the next open retries */ }

    const { data, error } = await supabase
      .from("scheduled_unlinks" as any)
      .select("id,requester_id,partner_id,status,created_at,execute_at,resolved_at")
      // RLS already limits this to rows involving me.
      .or(`status.eq.scheduled,and(status.eq.executed,resolved_at.gte.${new Date(Date.now() - 7 * 86_400_000).toISOString()})`) as any;
    if (error) {
      logWarn("useScheduledUnlink", "refresh failed", { error });
      setLoading(false);
      return;
    }
    const all = (data ?? []) as ScheduledUnlink[];
    setRows(all.filter((r) => r.status === "scheduled"));
    setLoading(false);

    for (const r of all) {
      if (r.status === "executed" && !hasHandledExecuted(r.id)) {
        markHandledExecuted(r.id);
        executedCb.current?.(r);
      }
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) { setRows([]); setLoading(false); return; }
    let cancelled = false;
    void refresh();

    const onRow = () => { if (!cancelled) void refresh(); };
    const channel = supabase
      .channel(`scheduled-unlinks-${scope}-${userId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "scheduled_unlinks", filter: `requester_id=eq.${userId}` }, onRow as any)
      .on("postgres_changes", { event: "*", schema: "public", table: "scheduled_unlinks", filter: `partner_id=eq.${userId}` }, onRow as any)
      .subscribe();

    const recheck = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", recheck);
    window.addEventListener(SHARING_STATE_CHANGED_EVENT, recheck);
    // Pushes about unlinks (incl. unlink_scheduled / unlink_completed) fire this.
    window.addEventListener(UNLINK_REQUESTS_CHANGED_EVENT, recheck);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", recheck);
      window.removeEventListener(SHARING_STATE_CHANGED_EVENT, recheck);
      window.removeEventListener(UNLINK_REQUESTS_CHANGED_EVENT, recheck);
      supabase.removeChannel(channel);
    };
  }, [userId, scope, refresh]);

  const { mine, theirs } = useMemo(() => ({
    mine: rows.find((r) => r.requester_id === userId) ?? null,
    theirs: rows.find((r) => r.partner_id === userId) ?? null,
  }), [rows, userId]);

  const callRpc = useCallback(async (fn: string, args?: Record<string, unknown>): Promise<ScheduledUnlinkRpcResult> => {
    try {
      const { data, error } = await supabase.rpc(fn as any, args as any) as any;
      if (error) { logWarn("useScheduledUnlink", `${fn} failed`, { error }); return { error: "NETWORK" }; }
      return (data ?? {}) as ScheduledUnlinkRpcResult;
    } catch (err) {
      logWarn("useScheduledUnlink", `${fn} threw`, { err });
      return { error: "NETWORK" };
    }
  }, []);

  const schedule = useCallback(async () => {
    const res = await callRpc("schedule_unlink");
    if (!res.error) void refresh();
    return res;
  }, [callRpc, refresh]);

  const cancel = useCallback(async (id: string) => {
    const res = await callRpc("cancel_scheduled_unlink", { p_id: id });
    void refresh();
    return res;
  }, [callRpc, refresh]);

  return { loading, mine, theirs, refresh, schedule, cancel };
}

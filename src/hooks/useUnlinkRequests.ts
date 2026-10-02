import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/appClient";
import { useAuth } from "@/hooks/useAuth";
import { useCall } from "@/contexts/CallContext";
import { isTerminal } from "@/lib/callStateMachine";
import { logWarn } from "@/lib/telemetry";
import {
  UNLINK_REQUESTS_CHANGED_EVENT,
  isOpenRequest,
  markPartnerUnlinked,
  type UnlinkRequest,
} from "@/lib/partnerUnlink";

/** What an unlink RPC hands back: a status on success, or an error code. */
export interface UnlinkRpcResult {
  status?: "pending" | "approved" | "declined" | "cancelled";
  request_id?: string;
  expires_at?: string;
  reason?: string;
  error?: string;
}

interface Options {
  /** Keeps realtime channel names unique when several components use this hook. */
  scope: string;
  /**
   * Fires when a request THIS user made gets answered (or the pairing ended
   * some other way). Not called for the initial load.
   */
  onOutgoingResolved?: (request: UnlinkRequest) => void;
}

/**
 * Live view of unlink requests involving the signed-in user:
 *  - `incoming`: someone (the partner) is asking THIS user to approve an unlink
 *  - `outgoing`: THIS user asked and is waiting for the partner
 *
 * Stays current through realtime (`unlink_requests` is in the realtime
 * publication; RLS limits each user to their own rows), plus a re-check when
 * the app returns to the foreground and when a push about it arrives — so a
 * flaky socket can delay an update but not lose it.
 *
 * Also wraps the three RPCs so screens don't each re-implement calling them.
 * The RPCs report failures as `{ error }` (they don't throw); a transport-level
 * failure comes back as `{ error: "NETWORK" }`.
 */
export function useUnlinkRequests({ scope, onOutgoingResolved }: Options) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [rows, setRows] = useState<UnlinkRequest[]>([]);
  const [loading, setLoading] = useState(true);

  // Latest callback without re-subscribing the channel when its identity changes.
  const resolvedCb = useRef(onOutgoingResolved);
  resolvedCb.current = onOutgoingResolved;

  const refresh = useCallback(async () => {
    if (!userId) { setRows([]); setLoading(false); return; }
    const { data, error } = await supabase
      .from("unlink_requests" as any)
      .select("id,requester_id,partner_id,status,created_at,expires_at,responded_at")
      .eq("status", "pending")
      .or(`requester_id.eq.${userId},partner_id.eq.${userId}`) as any;
    if (error) {
      // Keep whatever we already had — a failed re-check must not make an
      // approval prompt vanish out from under someone.
      logWarn("useUnlinkRequests", "refresh failed", { error });
      setLoading(false);
      return;
    }
    setRows((data ?? []) as UnlinkRequest[]);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    if (!userId) { setRows([]); setLoading(false); return; }
    let cancelled = false;
    void refresh();

    const onRow = (payload: { eventType?: string; new?: Record<string, unknown> }) => {
      if (cancelled) return;
      const next = payload.new as Partial<UnlinkRequest> | undefined;
      if (
        payload.eventType === "UPDATE" &&
        next?.requester_id === userId &&
        (next.status === "approved" || next.status === "declined")
      ) {
        resolvedCb.current?.(next as UnlinkRequest);
      }
      void refresh();
    };

    // postgres_changes filters take a single condition, so one channel with a
    // listener per role.
    const channel = supabase
      .channel(`unlink-requests-${scope}-${userId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "unlink_requests", filter: `requester_id=eq.${userId}` }, onRow as any)
      .on("postgres_changes", { event: "*", schema: "public", table: "unlink_requests", filter: `partner_id=eq.${userId}` }, onRow as any)
      .subscribe();

    const recheck = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", recheck);
    window.addEventListener(UNLINK_REQUESTS_CHANGED_EVENT, recheck);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", recheck);
      window.removeEventListener(UNLINK_REQUESTS_CHANGED_EVENT, recheck);
      supabase.removeChannel(channel);
    };
  }, [userId, scope, refresh]);

  const { incoming, outgoing } = useMemo(() => {
    const now = Date.now();
    const open = rows.filter((r) => isOpenRequest(r, now));
    return {
      incoming: open.filter((r) => r.partner_id === userId),
      outgoing: open.find((r) => r.requester_id === userId) ?? null,
    };
  }, [rows, userId]);

  const callRpc = useCallback(async (fn: string, args?: Record<string, unknown>): Promise<UnlinkRpcResult> => {
    try {
      const { data, error } = await supabase.rpc(fn as any, args as any) as any;
      if (error) {
        logWarn("useUnlinkRequests", `${fn} failed`, { error });
        return { error: "NETWORK" };
      }
      return (data ?? {}) as UnlinkRpcResult;
    } catch (err) {
      logWarn("useUnlinkRequests", `${fn} threw`, { err });
      return { error: "NETWORK" };
    }
  }, []);

  const requestUnlink = useCallback(async () => {
    const res = await callRpc("request_unlink");
    if (!res.error) void refresh();
    return res;
  }, [callRpc, refresh]);

  const respond = useCallback(async (requestId: string, approve: boolean) => {
    const res = await callRpc("respond_unlink", { p_request_id: requestId, p_approve: approve });
    void refresh();
    return res;
  }, [callRpc, refresh]);

  const cancel = useCallback(async (requestId: string) => {
    const res = await callRpc("cancel_unlink", { p_request_id: requestId });
    void refresh();
    return res;
  }, [callRpc, refresh]);

  return { loading, incoming, outgoing, refresh, requestUnlink, respond, cancel };
}

/**
 * Wrap-up after this device's pairing has ended (either side approved):
 * forget the cached partner, then reload so every screen and context that
 * captured the old partner id (Chat, Map, Groic, theme sync, call state…)
 * starts clean instead of showing — or trying to message — an ex-partner.
 *
 * If a call is in progress the reload waits until it ends, rather than
 * dropping it.
 */
export function useFinishUnlink() {
  const { user } = useAuth();
  const { callMachineState } = useCall();
  const callActive = callMachineState.status !== "IDLE" && !isTerminal(callMachineState.status);
  const reloadWhenIdle = useRef(false);

  useEffect(() => {
    if (!callActive && reloadWhenIdle.current) {
      reloadWhenIdle.current = false;
      window.location.reload();
    }
  }, [callActive]);

  return useCallback(() => {
    if (!user) return;
    markPartnerUnlinked(user.id);
    if (callActive) { reloadWhenIdle.current = true; return; }
    window.location.reload();
  }, [user, callActive]);
}

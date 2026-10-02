import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/appClient";
import { useAuth } from "@/hooks/useAuth";
import { logWarn } from "@/lib/telemetry";
import { SHARING_STATE_CHANGED_EVENT, type ScheduledUnlinkRpcResult } from "@/lib/scheduledUnlink";

/**
 * Whether THIS person has stopped sharing with their partner.
 *
 * `stopped` is server truth (public.sharing_state, own row only). The database
 * itself drops location / device-status / new-share writes while it is set, so
 * a stale client can't leak by accident — this hook only decides what the UI
 * and the on-device trackers do. It defaults to "sharing" until the first read
 * lands; the DB triggers are the backstop for that gap.
 */
export function useSharingState() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [stopped, setStopped] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!userId) { setStopped(false); setLoading(false); return; }
    const { data, error } = await supabase
      .from("sharing_state" as any)
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle() as any;
    if (error) {
      logWarn("useSharingState", "refresh failed", { error });
      setLoading(false);
      return; // keep what we had
    }
    setStopped(!!data);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    void refresh();
    const recheck = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", recheck);
    window.addEventListener(SHARING_STATE_CHANGED_EVENT, recheck);
    return () => {
      document.removeEventListener("visibilitychange", recheck);
      window.removeEventListener(SHARING_STATE_CHANGED_EVENT, recheck);
    };
  }, [refresh]);

  const call = useCallback(async (fn: "stop_sharing" | "resume_sharing"): Promise<ScheduledUnlinkRpcResult> => {
    try {
      const { data, error } = await supabase.rpc(fn as any) as any;
      if (error) { logWarn("useSharingState", `${fn} failed`, { error }); return { error: "NETWORK" }; }
      const res = (data ?? {}) as ScheduledUnlinkRpcResult;
      if (!res.error) {
        setStopped(fn === "stop_sharing");
        // Other mounted copies of this hook (LocationContext, Partner screen) re-read.
        window.dispatchEvent(new CustomEvent(SHARING_STATE_CHANGED_EVENT));
      }
      return res;
    } catch (err) {
      logWarn("useSharingState", `${fn} threw`, { err });
      return { error: "NETWORK" };
    }
  }, []);

  const stopSharing = useCallback(() => call("stop_sharing"), [call]);
  const resumeSharing = useCallback(() => call("resume_sharing"), [call]);

  return { stopped, loading, stopSharing, resumeSharing, refresh };
}

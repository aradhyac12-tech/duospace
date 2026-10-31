// Reads the caller's own active Razorpay subscription (RLS: own rows only) and
// lets them stop auto-renewal. Access continues until the paid period ends.
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/appClient";
import { invokeEdgeFunction } from "@/lib/edgeFunction";
import { useAuth } from "@/hooks/useAuth";

export function useRazorpaySubscription() {
  const { user } = useAuth();
  const [active, setActive] = useState(false);
  const [cancelScheduled, setCancelScheduled] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!user) { setActive(false); return; }
    const { data } = await (supabase as any)
      .from("payment_transactions")
      .select("metadata")
      .eq("user_id", user.id)
      .eq("provider", "razorpay")
      .eq("status", "active")
      .not("provider_subscription_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    setActive(!!data);
    setCancelScheduled(!!data?.metadata?.cancel_requested_at);
  }, [user]);

  useEffect(() => { void load(); }, [load]);

  const cancelRenewal = useCallback(async () => {
    setBusy(true);
    try {
      await invokeEdgeFunction("cancel-razorpay-subscription", { body: {} });
      setCancelScheduled(true);
      return true;
    } catch {
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  return { active, cancelScheduled, busy, cancelRenewal, reload: load };
}

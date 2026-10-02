// Client-side READ of the server-authoritative entitlement. This hook never
// decides plan status itself: it reflects what public.my_entitlement returned,
// computed in Postgres from entitlements + the caller's CURRENT mutual partner
// link. Nothing here is trusted for writes; server operations (AI quota,
// purchases) re-resolve the plan themselves.
//
// States (never a false "Free" while we simply can't reach the server):
//   checking    first load, no answer yet
//   ready       fresh answer from the server
//   stale       server unreachable; showing the last answer we got (<= 7 days)
//   unavailable server unreachable and nothing cached — plan is FREE for
//               gating but the UI should say "couldn't check", not "Free"
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/appClient";
import { useAuth } from "@/hooks/useAuth";
import {
  type EntitlementPlan,
  type FeatureFlag,
  type PlanLevel,
  type PlanScope,
  getPlanLevel,
  getPlanScope,
  isCouplePlan,
  isComplimentaryPlan,
  isPlus as planIsPlus,
  isPro as planIsPro,
  planIncludesFeature,
} from "@/lib/monetization/config";

export const ENTITLEMENT_CHANGED_EVENT = "duo:entitlement-changed";

export type EntitlementStatus = "checking" | "ready" | "stale" | "unavailable";

interface EntitlementState {
  plan: EntitlementPlan;
  status: EntitlementStatus;
  error: string | null;
}

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const KNOWN_PLANS: ReadonlySet<string> = new Set([
  "FREE", "PLUS_INDIVIDUAL", "PLUS_COUPLE", "PRO_INDIVIDUAL", "PRO_COUPLE",
  "LIFETIME", "FOUNDER", "BETA", "ADMIN",
]);

function cacheKey(userId: string) { return `duo-entitlement:${userId}`; }

function readCache(userId: string): EntitlementPlan | null {
  try {
    const raw = localStorage.getItem(cacheKey(userId));
    if (!raw) return null;
    const { plan, at } = JSON.parse(raw) as { plan: string; at: number };
    if (!KNOWN_PLANS.has(plan) || Date.now() - at > CACHE_TTL_MS) return null;
    return plan as EntitlementPlan;
  } catch { return null; }
}

function writeCache(userId: string, plan: EntitlementPlan) {
  try { localStorage.setItem(cacheKey(userId), JSON.stringify({ plan, at: Date.now() })); } catch { /* private mode */ }
}

export function useEntitlement() {
  const { user } = useAuth();
  const [state, setState] = useState<EntitlementState>({ plan: "FREE", status: "checking", error: null });

  const refresh = useCallback(async () => {
    if (!user) { setState({ plan: "FREE", status: "ready", error: null }); return; }
    setState((s) => (s.status === "ready" ? s : { ...s, status: "checking" }));
    const { data, error } = await supabase.from("my_entitlement").select("plan").single();
    if (error || !data?.plan || !KNOWN_PLANS.has(data.plan as string)) {
      const cached = readCache(user.id);
      // Fail safe: an unreachable server never GRANTS anything new. We only
      // keep showing what the server last told us, or FREE for gating.
      setState(cached
        ? { plan: cached, status: "stale", error: error?.message ?? "unknown plan" }
        : { plan: "FREE", status: "unavailable", error: error?.message ?? "unknown plan" });
      return;
    }
    const plan = data.plan as EntitlementPlan;
    writeCache(user.id, plan);
    setState({ plan, status: "ready", error: null });
  }, [user]);

  useEffect(() => { void refresh(); }, [refresh]);

  // The "an admin granted you access" card (UserNoticeHost) announces a plan
  // change; re-read the server-authoritative answer instead of waiting for the
  // next app start. The event carries no plan - nothing is trusted from it.
  useEffect(() => {
    const onChanged = () => { void refresh(); };
    window.addEventListener(ENTITLEMENT_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(ENTITLEMENT_CHANGED_EVENT, onChanged);
  }, [refresh]);

  const plan = state.plan;
  const level: PlanLevel = getPlanLevel(plan);
  const scope: PlanScope = getPlanScope(plan);

  const canUseFeature = useCallback(
    (feature: FeatureFlag) => planIncludesFeature(plan, feature),
    [plan],
  );
  /** True only when we KNOW the user lacks the feature (never while checking). */
  const isLocked = useCallback(
    (feature: FeatureFlag) => state.status !== "checking" && state.status !== "unavailable" && !planIncludesFeature(plan, feature),
    [plan, state.status],
  );

  return {
    plan,
    level,
    scope,
    status: state.status,
    loading: state.status === "checking",
    error: state.error,
    isPlus: planIsPlus(plan),
    isPro: planIsPro(plan),
    isCouple: isCouplePlan(plan),
    isComplimentary: isComplimentaryPlan(plan),
    canUseFeature,
    isLocked,
    refreshEntitlement: refresh,
  };
}

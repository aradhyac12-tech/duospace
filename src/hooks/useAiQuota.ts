// Server-authoritative AI quota. The counter lives in Postgres
// (public.consume_ai_quota, keyed on auth.uid()); the client only asks and
// obeys. There is no client-side counter and no way to name another user.
import { useCallback } from "react";
import { supabase } from "@/integrations/supabase/appClient";

export type AiQuotaBucket = "AI_STANDARD" | "AI_DEEP";

export interface AiQuotaResult {
  allowed: boolean;
  /** null = uncapped (internal plans only) */
  remaining: number | null;
  reset_at: string | null;
  reason: "ok" | "quota_exceeded" | "not_in_plan" | "not_authenticated" | "no_quota_configured" | "unverified";
  level?: string;
  limit?: number | null;
}

export async function consumeAiQuota(bucket: AiQuotaBucket, cost = 1): Promise<AiQuotaResult> {
  try {
    const { data, error } = await supabase.rpc("consume_ai_quota" as never, { _bucket: bucket, _cost: cost } as never);
    if (error || !data) throw error ?? new Error("empty");
    return data as unknown as AiQuotaResult;
  } catch {
    // Offline / server unreachable. These helpers run on-device, so we do not
    // break the user's conversation over a metering outage: allow, flagged as
    // unverified. (Cloud AI, when it exists, must fail CLOSED server-side.)
    return { allowed: true, remaining: null, reset_at: null, reason: "unverified" };
  }
}

export function useAiQuota() {
  return { consume: useCallback(consumeAiQuota, []) };
}

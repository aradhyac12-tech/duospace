// Shared persistent rate limiter for edge functions.
// Uses the `consume_rate_limit` SQL function backed by the `rate_limits` table.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

/**
 * Returns true if the request is ALLOWED, false if rate-limited.
 */
export async function consumeRateLimit(
  userId: string,
  bucket: string,
  max: number,
  windowSeconds: number,
): Promise<boolean> {
  try {
    const { data, error } = await admin.rpc("consume_rate_limit", {
      _user_id: userId,
      _bucket: bucket,
      _max: max,
      _window_seconds: windowSeconds,
    });
    if (error) {
      console.error("[rateLimit] rpc error:", error.message);
      // Fail open — never block a legitimate user on infrastructure errors,
      // but log loudly so it's visible.
      return true;
    }
    return data === true;
  } catch (e) {
    console.error("[rateLimit] exception:", e);
    return true;
  }
}

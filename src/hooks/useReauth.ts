import { useCallback, useMemo } from "react";
import { supabase } from "@/integrations/supabase/appClient";
import { useAuth } from "@/hooks/useAuth";
import { userHasPassword } from "@/lib/passwordStatus";

export type ReauthMethod = "password" | "code";

/**
 * Re-authentication for irreversible actions.
 *  - Accounts with an email+password identity confirm with their password.
 *  - Everyone else (Google/Apple/passkey-only) confirms with a 6-digit code
 *    emailed to them.
 * Either path creates a fresh session, which stamps a new `amr` timestamp in
 * the JWT. The database checks that timestamp (see stop_sharing), so this is
 * enforced server-side, not just by the UI.
 */
export function useReauth() {
  const { user } = useAuth();
  const email = user?.email ?? null;

  const method: ReauthMethod = useMemo(() => {
    return userHasPassword(user) ? "password" : "code";
  }, [user]);

  const sendCode = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    if (!email) return { ok: false, error: "No email on this account." };
    const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
    return error ? { ok: false, error: error.message } : { ok: true };
  }, [email]);

  const verify = useCallback(async (secret: string): Promise<{ ok: boolean; error?: string }> => {
    if (!email) return { ok: false, error: "No email on this account." };
    const value = secret.trim();
    if (!value) return { ok: false, error: method === "password" ? "Enter your password." : "Enter the code." };
    try {
      const { error } = method === "password"
        ? await supabase.auth.signInWithPassword({ email, password: value })
        : await supabase.auth.verifyOtp({ email, token: value, type: "email" });
      if (error) {
        return { ok: false, error: method === "password" ? "That password isn't right." : "That code isn't right or has expired." };
      }
      return { ok: true };
    } catch {
      return { ok: false, error: "Couldn't check that. Check your connection and try again." };
    }
  }, [email, method]);

  return { method, email, sendCode, verify };
}

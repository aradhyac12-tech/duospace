import { useCallback, useEffect, useState } from "react";
import { ShieldOff } from "lucide-react";
import { supabase } from "@/integrations/supabase/appClient";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";

/**
 * Full-screen stop for an account an admin has blocked. The real enforcement
 * is the Auth ban applied by the admin-user-action function (no sign-in, no
 * token refresh); this screen covers the minutes before an already-issued
 * access token lapses, and tells the person why. Fails open on read errors.
 */
const BlockedGate = () => {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [blocked, setBlocked] = useState<{ reason: string | null } | null>(null);

  const check = useCallback(async () => {
    if (!userId) { setBlocked(null); return; }
    const { data, error } = await (supabase as any).from("user_moderation").select("status,reason").eq("user_id", userId).maybeSingle();
    if (error) return;
    setBlocked(data?.status === "blocked" ? { reason: data.reason ?? null } : null);
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    void check();
    const channel = supabase
      .channel(`moderation-${userId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "user_moderation", filter: `user_id=eq.${userId}` }, () => { void check(); })
      .subscribe();
    const recheck = () => { if (!document.hidden) void check(); };
    document.addEventListener("visibilitychange", recheck);
    return () => { document.removeEventListener("visibilitychange", recheck); supabase.removeChannel(channel); };
  }, [userId, check]);

  if (!blocked) return null;

  return (
    <div role="alertdialog" aria-modal="true" aria-labelledby="blocked-title" className="fixed inset-0 z-[100] bg-background flex items-center justify-center p-8">
      <div className="max-w-[340px] text-center space-y-4">
        <span className="mx-auto h-16 w-16 rounded-full bg-destructive/10 flex items-center justify-center">
          <ShieldOff className="h-7 w-7 text-destructive" aria-hidden="true" />
        </span>
        <h1 id="blocked-title" className="text-xl font-semibold text-foreground">Account blocked</h1>
        <p className="text-sm text-muted-foreground leading-relaxed">
          An admin has blocked this account.{blocked.reason ? <> Reason: <span className="text-foreground">{blocked.reason}</span>.</> : null}{" "}
          Your chats and photos haven't been deleted. If you think this is a mistake, please contact support.
        </p>
        <Button variant="outline" className="rounded-xl" onClick={() => { void supabase.auth.signOut(); }}>Sign out</Button>
      </div>
    </div>
  );
};

export default BlockedGate;

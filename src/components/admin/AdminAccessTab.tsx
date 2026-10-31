import { useState } from "react";
import { Search, Loader2, Crown, FlaskConical, X, ShieldCheck } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { hapticMedium } from "@/lib/haptics";
import { adminApi, type AdminUser } from "@/lib/admin/adminApi";
import { Empty, LinkBadge, PlanBadge, Spinner, useAdminList } from "./AdminBits";
import { PartnerLine, personName } from "./AdminUsersTab";

/**
 * Where Founder / Beta access is given and taken away. Same server rules as
 * before (only FOUNDER/BETA are grantable, paid plans never are). New: every
 * person shown here also shows who they're connected to, and granting sends
 * them a "you've been granted access" card + push (database trigger).
 */
const AdminAccessTab = () => {
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<AdminUser[]>([]);
  const [searchedOnce, setSearchedOnce] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const { rows: grants, loading: grantsLoading, reload: reloadGrants } = useAdminList(() => adminApi.listGrants(), []);

  const search = async () => {
    const q = query.trim();
    if (q.length < 3) { toast({ title: "Type at least 3 characters", variant: "destructive" }); return; }
    setSearching(true); setSearchedOnce(true);
    try { setResults(await adminApi.listUsers(q, "all", 20, 0)); }
    catch (e) { toast({ title: "Search failed", description: e instanceof Error ? e.message : "", variant: "destructive" }); }
    finally { setSearching(false); }
  };

  const grant = async (u: AdminUser, plan: "FOUNDER" | "BETA") => {
    setBusyKey(`${u.user_id}:${plan}`);
    try {
      await adminApi.grant(u.user_id, plan);
      hapticMedium();
      toast({ title: `${personName(u)} is now ${plan === "FOUNDER" ? "a Founder" : "a Beta tester"}`, description: "They'll get a card in the app." });
      setResults((prev) => prev.map((r) => (r.user_id === u.user_id ? { ...r, current_plan: plan } : r)));
      await reloadGrants();
    } catch (e) {
      toast({ title: "Couldn't grant access", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally { setBusyKey(null); }
  };

  const revoke = async (entitlementId: string, userId: string, label: string) => {
    setBusyKey(`rev:${entitlementId}`);
    try {
      await adminApi.revoke(entitlementId);
      hapticMedium();
      toast({ title: `Revoked ${label}` });
      setResults((prev) => prev.map((r) => (r.user_id === userId ? { ...r, current_plan: "FREE" } : r)));
      await reloadGrants();
    } catch (e) {
      toast({ title: "Couldn't revoke", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally { setBusyKey(null); }
  };

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <p className="text-sm font-medium text-foreground">Granted access</p>
        {grantsLoading ? <Spinner /> : grants.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">No one has been manually granted access yet.</p>
        ) : (
          <div className="bg-card rounded-2xl border border-border/60 divide-y divide-border/40 overflow-hidden">
            {grants.map((g) => {
              // The admin's own bootstrap row can't be revoked from here (would lock the admin out).
              const isSelfBootstrap = g.source === "admin_grant";
              return (
                <div key={g.entitlement_id} className="flex items-center gap-3 px-4 py-3.5">
                  <span className="h-9 w-9 rounded-full bg-accent/15 flex items-center justify-center shrink-0">
                    {g.plan === "ADMIN" ? <ShieldCheck className="h-4 w-4 text-accent" aria-hidden="true" /> : <Crown className="h-4 w-4 text-accent" aria-hidden="true" />}
                  </span>
                  <div className="flex-1 min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-foreground truncate">{g.username || g.email}</p>
                      <PlanBadge plan={g.plan} />
                    </div>
                    <PartnerLine u={{ link_state: g.link_state, partner_username: g.partner_username, partner_display_name: null, partner_email: g.partner_email }} />
                  </div>
                  {!isSelfBootstrap && (
                    <Button size="sm" variant="outline" disabled={busyKey === `rev:${g.entitlement_id}`} onClick={() => revoke(g.entitlement_id, g.user_id, g.plan)}>
                      {busyKey === `rev:${g.entitlement_id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><X className="h-3.5 w-3.5" /> Revoke</>}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <p className="text-sm font-medium text-foreground">Give access</p>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <Input
              value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void search(); }}
              placeholder="Search by email or username" className="pl-9"
            />
          </div>
          <Button onClick={search} disabled={searching}>{searching ? <Loader2 className="h-4 w-4 animate-spin" /> : "Search"}</Button>
        </div>

        {searchedOnce && !searching && results.length === 0 && <Empty>No accounts matched.</Empty>}

        <div className="space-y-3">
          {results.map((u) => {
            const locked = u.current_plan === "ADMIN";
            return (
              <div key={u.user_id} className="bg-card rounded-2xl border border-border/60 p-4 space-y-3">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-foreground truncate">{personName(u)}</p>
                    <PlanBadge plan={u.current_plan} />
                  </div>
                  <p className="text-[11px] text-muted-foreground truncate">{u.email}</p>
                  <PartnerLine u={u} />
                  <div className="pt-1"><LinkBadge state={u.link_state} /></div>
                </div>
                {!locked && (
                  <div className="grid grid-cols-2 gap-2">
                    {(["FOUNDER", "BETA"] as const).map((plan) => (
                      <Button
                        key={plan} size="sm" variant={u.current_plan === plan ? "secondary" : "outline"}
                        disabled={!!busyKey || u.current_plan === plan} onClick={() => grant(u, plan)}
                      >
                        {busyKey === `${u.user_id}:${plan}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : plan === "FOUNDER" ? <><Crown className="h-3.5 w-3.5" /> Founder</> : <><FlaskConical className="h-3.5 w-3.5" /> Beta</>}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <p className="text-[11px] text-muted-foreground text-center px-2">
          Grants last until revoked and only ever cover Founder or Beta — never paid plans. The person gets a card telling them you've granted it.
        </p>
      </section>
    </div>
  );
};

export default AdminAccessTab;

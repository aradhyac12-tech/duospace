import { useEffect, useState } from "react";
import { Search, ShieldCheck, ShieldOff, BadgeCheck, Crown, FlaskConical, Loader2, UserRound, Heart, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { hapticMedium } from "@/lib/haptics";
import { adminApi, timeAgo, type AdminGrant, type AdminUser, type UserFilter } from "@/lib/admin/adminApi";
import { Chips, Empty, LinkBadge, PAGE_SIZE, Pager, PlanBadge, Spinner, useAdminList, useDebounced } from "./AdminBits";

const FILTERS: { value: UserFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "linked", label: "Connected" },
  { value: "solo", label: "No partner" },
  { value: "one_way", label: "One-way" },
  { value: "unverified", label: "Unverified" },
  { value: "blocked", label: "Blocked" },
  { value: "paid", label: "Paid" },
  { value: "complimentary", label: "Founder/Beta" },
];

export const personName = (u: { display_name?: string | null; username?: string | null; email?: string }) =>
  u.display_name || u.username || u.email || "Unknown";

/** "Partner" line shown on every user row: the answer to "who is connected to whom". */
export const PartnerLine = ({ u }: { u: Pick<AdminUser, "link_state" | "partner_username" | "partner_display_name" | "partner_email"> }) => {
  if (u.link_state === "solo") return <p className="text-[11px] text-muted-foreground">No partner linked</p>;
  const name = u.partner_display_name || u.partner_username || "Unknown";
  return (
    <p className="text-[11px] text-foreground/80 truncate">
      <Heart className="inline h-3 w-3 mr-1 text-accent" aria-hidden="true" />
      {u.link_state === "mutual" ? "Connected with " : "Points at "}
      <span className="font-medium">{name}</span>
      {u.partner_email ? <span className="text-muted-foreground"> · {u.partner_email}</span> : null}
    </p>
  );
};

const AdminUsersTab = ({ initialQuery = "" }: { initialQuery?: string }) => {
  const [query, setQuery] = useState(initialQuery);
  const [filter, setFilter] = useState<UserFilter>("all");
  const [page, setPage] = useState(0);
  const dq = useDebounced(query);
  const [selected, setSelected] = useState<AdminUser | null>(null);

  useEffect(() => { setPage(0); }, [dq, filter]);
  useEffect(() => { setQuery(initialQuery); }, [initialQuery]);

  const { rows, loading, reload } = useAdminList(
    () => adminApi.listUsers(dq.trim(), filter, PAGE_SIZE, page * PAGE_SIZE),
    [dq, filter, page],
  );
  const total = rows[0]?.total_count ?? 0;

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, username, email or partner" className="pl-9" />
      </div>
      <Chips value={filter} onChange={setFilter} options={FILTERS} />

      {loading && rows.length === 0 ? <Spinner /> : rows.length === 0 ? <Empty>No accounts match.</Empty> : (
        <div className="space-y-2">
          {rows.map((u) => (
            <button
              key={u.user_id}
              onClick={() => setSelected(u)}
              className="w-full text-left bg-card rounded-2xl border border-border/60 p-3.5 active:scale-[0.99] transition-transform"
            >
              <div className="flex items-start gap-3">
                <span className="h-10 w-10 rounded-full bg-accent/15 flex items-center justify-center shrink-0">
                  <UserRound className="h-[18px] w-[18px] text-accent" aria-hidden="true" />
                </span>
                <div className="flex-1 min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-foreground truncate">{personName(u)}</p>
                    <PlanBadge plan={u.current_plan} />
                  </div>
                  <p className="text-[11px] text-muted-foreground truncate">{u.email}</p>
                  <PartnerLine u={u} />
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    <LinkBadge state={u.link_state} />
                    {!u.email_verified && <span className="text-[10px] rounded-full px-2 py-0.5 bg-amber-500/10 text-amber-500">Unverified</span>}
                    {u.blocked && <span className="text-[10px] rounded-full px-2 py-0.5 bg-destructive/10 text-destructive">Blocked</span>}
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
      <Pager page={page} total={total} onPage={setPage} loading={loading} />

      <UserSheet
        user={selected}
        onClose={() => setSelected(null)}
        onChanged={async (patch) => {
          if (patch) setSelected((s) => (s ? { ...s, ...patch } : s));
          await reload();
        }}
        onOpenPartner={(partnerEmail) => { setSelected(null); setFilter("all"); setQuery(partnerEmail); }}
      />
    </div>
  );
};

const UserSheet = ({
  user, onClose, onChanged, onOpenPartner,
}: {
  user: AdminUser | null;
  onClose: () => void;
  onChanged: (patch?: Partial<AdminUser>) => Promise<void>;
  onOpenPartner: (partnerEmail: string) => void;
}) => {
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [grants, setGrants] = useState<AdminGrant[]>([]);
  const [grantsLoading, setGrantsLoading] = useState(false);
  const [confirmBlock, setConfirmBlock] = useState(false);
  const [reason, setReason] = useState("");

  const userId = user?.user_id;
  const loadGrants = async () => {
    setGrantsLoading(true);
    try {
      const all = await adminApi.listGrants();
      setGrants(all.filter((g) => g.user_id === userId));
    } catch { setGrants([]); }
    setGrantsLoading(false);
  };
  useEffect(() => { if (userId) { setReason(""); void loadGrants(); } /* eslint-disable-next-line */ }, [userId]);

  if (!user) return null;
  const isAdmin = user.current_plan === "ADMIN";
  const manual = grants.find((g) => g.source === "founder_grant" || g.source === "beta_grant");

  const run = async (key: string, fn: () => Promise<void>, ok: string, patch?: Partial<AdminUser>) => {
    setBusy(key);
    try {
      await fn();
      hapticMedium();
      toast({ title: ok });
      await onChanged(patch);
      await loadGrants();
    } catch (e) {
      toast({ title: "Action failed", description: e instanceof Error ? e.message : "Try again", variant: "destructive" });
    } finally { setBusy(null); }
  };

  const grant = (plan: "FOUNDER" | "BETA") =>
    run(`grant-${plan}`, () => adminApi.grant(user.user_id, plan),
      `${personName(user)} is now ${plan === "FOUNDER" ? "a Founder" : "a Beta tester"} — they'll see a card in the app`,
      { current_plan: plan });

  return (
    <>
      <Sheet open={!!user} onOpenChange={(o) => { if (!o) onClose(); }}>
        <SheetContent side="bottom" className="rounded-t-3xl max-h-[88vh] overflow-y-auto pb-8">
          <SheetHeader className="text-left">
            <SheetTitle className="flex items-center gap-2">{personName(user)} <PlanBadge plan={user.current_plan} /></SheetTitle>
            <SheetDescription className="truncate">{user.email}</SheetDescription>
          </SheetHeader>

          <div className="space-y-5 pt-4">
            <section className="space-y-2">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Connection</h3>
              <div className="rounded-xl bg-muted/40 p-3 space-y-1.5">
                <LinkBadge state={user.link_state} />
                {user.link_state === "solo" ? (
                  <p className="text-sm text-foreground">Not linked to anyone.</p>
                ) : (
                  <>
                    <p className="text-sm font-medium text-foreground">
                      {user.partner_display_name || user.partner_username || "Unknown"}
                      {user.partner_username && user.partner_display_name ? <span className="text-muted-foreground font-normal"> @{user.partner_username}</span> : null}
                    </p>
                    {user.partner_email && <p className="text-[11px] text-muted-foreground">{user.partner_email}</p>}
                    {user.link_state === "one_way" && (
                      <p className="text-[11px] text-amber-500">This account points at them, but they haven't linked back — not a completed connection.</p>
                    )}
                    {user.partner_email && (
                      <Button size="sm" variant="outline" onClick={() => onOpenPartner(user.partner_email!)}>View partner's account</Button>
                    )}
                  </>
                )}
              </div>
            </section>

            <section className="space-y-1 text-[12px]">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Account</h3>
              <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1">
                <dt className="text-muted-foreground">Email</dt><dd>{user.email_verified ? "Verified" : "Not verified"}</dd>
                <dt className="text-muted-foreground">Joined</dt><dd>{new Date(user.created_at).toLocaleDateString()}</dd>
                <dt className="text-muted-foreground">Last seen</dt><dd>{timeAgo(user.last_seen_at)}</dd>
                <dt className="text-muted-foreground">Status</dt><dd>{user.blocked ? `Blocked${user.block_reason ? ` — ${user.block_reason}` : ""}` : "Active"}</dd>
              </dl>
            </section>

            <section className="space-y-2">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Access</h3>
              {isAdmin ? (
                <p className="text-[11px] text-muted-foreground">This is the admin account — its access can't be changed here.</p>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <Button variant="outline" disabled={!!busy || user.current_plan === "FOUNDER"} onClick={() => grant("FOUNDER")}>
                      {busy === "grant-FOUNDER" ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Crown className="h-4 w-4" /> Founder</>}
                    </Button>
                    <Button variant="outline" disabled={!!busy || user.current_plan === "BETA"} onClick={() => grant("BETA")}>
                      {busy === "grant-BETA" ? <Loader2 className="h-4 w-4 animate-spin" /> : <><FlaskConical className="h-4 w-4" /> Beta</>}
                    </Button>
                  </div>
                  {grantsLoading ? <Spinner /> : manual && (
                    <Button
                      variant="ghost" size="sm" className="text-destructive" disabled={!!busy}
                      onClick={() => run("revoke", () => adminApi.revoke(manual.entitlement_id), `Revoked ${manual.plan}`, { current_plan: "FREE" })}
                    >
                      {busy === "revoke" ? <Loader2 className="h-4 w-4 animate-spin" /> : <><X className="h-3.5 w-3.5" /> Revoke {manual.plan}</>}
                    </Button>
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    Granting Founder or Beta sends them a "you've been granted access" card and a push. Paid plans can't be granted here.
                  </p>
                </>
              )}
            </section>

            {!isAdmin && (
              <section className="space-y-2">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Moderation</h3>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="outline" disabled={!!busy || user.email_verified}
                    onClick={() => run("verify", () => adminApi.userAction("verify", user.user_id).then(() => undefined), "Email marked verified", { email_verified: true })}
                  >
                    {busy === "verify" ? <Loader2 className="h-4 w-4 animate-spin" /> : <><BadgeCheck className="h-4 w-4" /> {user.email_verified ? "Verified" : "Verify"}</>}
                  </Button>
                  {user.blocked ? (
                    <Button
                      variant="outline" disabled={!!busy}
                      onClick={() => run("unblock", () => adminApi.userAction("unblock", user.user_id).then(() => undefined), "Account unblocked", { blocked: false, block_reason: null })}
                    >
                      {busy === "unblock" ? <Loader2 className="h-4 w-4 animate-spin" /> : <><ShieldCheck className="h-4 w-4" /> Unblock</>}
                    </Button>
                  ) : (
                    <Button variant="outline" className="text-destructive" disabled={!!busy} onClick={() => setConfirmBlock(true)}>
                      <ShieldOff className="h-4 w-4" /> Block
                    </Button>
                  )}
                </div>
              </section>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmBlock} onOpenChange={setConfirmBlock}>
        <AlertDialogContent className="rounded-2xl max-w-[360px]">
          <AlertDialogHeader>
            <AlertDialogTitle>Block {personName(user)}?</AlertDialogTitle>
            <AlertDialogDescription>
              They'll be signed out and unable to sign in again until you unblock them. Their chats, photos and partner link are not touched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Reason (shown to them, optional)" />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => run("block", () => adminApi.userAction("block", user.user_id, reason.trim() || undefined).then(() => undefined), "Account blocked", { blocked: true, block_reason: reason.trim() || null })}
            >
              Block
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export default AdminUsersTab;

import { useEffect, useState } from "react";
import { Search, Heart } from "lucide-react";
import { Input } from "@/components/ui/input";
import { adminApi, type AdminCouple } from "@/lib/admin/adminApi";
import { Empty, LinkBadge, PAGE_SIZE, Pager, PlanBadge, Spinner, useAdminList, useDebounced } from "./AdminBits";

const Person = ({ name, email, plan, blocked }: { name: string; email: string; plan: string; blocked: boolean }) => (
  <div className="flex-1 min-w-0">
    <div className="flex items-center gap-1.5">
      <p className="text-sm font-medium text-foreground truncate">{name}</p>
      <PlanBadge plan={plan} />
    </div>
    <p className="text-[11px] text-muted-foreground truncate">{email}</p>
    {blocked && <span className="text-[10px] text-destructive">Blocked</span>}
  </div>
);

const CoupleRow = ({ c }: { c: AdminCouple }) => (
  <div className="bg-card rounded-2xl border border-border/60 p-3.5 space-y-2">
    <div className="flex items-center gap-2">
      <Person name={c.a_display_name || c.a_username || "Unknown"} email={c.a_email} plan={c.a_plan} blocked={c.a_blocked} />
      <Heart className="h-4 w-4 text-accent shrink-0" aria-hidden="true" />
      <Person name={c.b_display_name || c.b_username || "Unknown"} email={c.b_email} plan={c.b_plan} blocked={c.b_blocked} />
    </div>
    <div className="flex items-center gap-2">
      <LinkBadge state={c.link_state} />
      {c.link_state === "one_way" && (
        <span className="text-[10px] text-muted-foreground">left account points at right; right hasn't linked back</span>
      )}
    </div>
  </div>
);

/** Every connected pair (and every one-way link), so you can see exactly who is linked to whom. */
const AdminCouplesTab = () => {
  const [query, setQuery] = useState("");
  const dq = useDebounced(query);
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [dq]);

  const { rows, loading } = useAdminList(() => adminApi.listCouples(dq.trim(), PAGE_SIZE, page * PAGE_SIZE), [dq, page]);
  const total = rows[0]?.total_count ?? 0;

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search either person" className="pl-9" />
      </div>
      {loading && rows.length === 0 ? <Spinner /> : rows.length === 0 ? <Empty>No linked accounts found.</Empty> : (
        <div className="space-y-2">
          {rows.map((c) => <CoupleRow key={`${c.a_user_id}-${c.b_user_id}`} c={c} />)}
        </div>
      )}
      <Pager page={page} total={total} onPage={setPage} loading={loading} />
    </div>
  );
};

export default AdminCouplesTab;

import { useEffect, useState } from "react";
import { adminApi, formatMoney, timeAgo, type AdminTransaction, type PaymentSummaryRow, type TxnFilter } from "@/lib/admin/adminApi";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Chips, Empty, PAGE_SIZE, Pager, PlanBadge, Spinner, StatCard, useAdminList } from "./AdminBits";

const FILTERS: { value: TxnFilter; label: string }[] = [
  { value: "all", label: "All" }, { value: "paid", label: "Payments" }, { value: "refunded", label: "Refunds" },
  { value: "failed", label: "Failed" }, { value: "pending", label: "Pending" },
];

const STATUS_STYLE: Record<string, string> = {
  failed: "bg-destructive/10 text-destructive",
  refunded: "bg-amber-500/10 text-amber-500",
  revoked: "bg-amber-500/10 text-amber-500",
  pending: "bg-muted text-muted-foreground",
};

const AdminPaymentsTab = () => {
  const { toast } = useToast();
  const [summary, setSummary] = useState<PaymentSummaryRow[] | null>(null);
  const [filter, setFilter] = useState<TxnFilter>("all");
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [filter]);

  useEffect(() => {
    let live = true;
    adminApi.paymentsSummary()
      .then((s) => { if (live) setSummary(s); })
      .catch((e) => toast({ title: "Couldn't load payments", description: e instanceof Error ? e.message : "", variant: "destructive" }));
    return () => { live = false; };
  }, [toast]);

  const { rows, loading } = useAdminList<AdminTransaction>(() => adminApi.listTransactions(filter, PAGE_SIZE, page * PAGE_SIZE), [filter, page]);
  const total = rows[0]?.total_count ?? 0;

  return (
    <div className="space-y-4">
      {summary === null ? <Spinner /> : summary.length === 0 ? (
        <Empty>No payments recorded yet.</Empty>
      ) : summary.map((s) => (
        <div key={s.currency} className="space-y-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{s.currency}</p>
          <div className="grid grid-cols-2 gap-2.5">
            <StatCard label="Payments" value={formatMoney(s.gross_minor, s.currency)} hint={`${s.paid_count} transaction(s)`} />
            <StatCard label="Refunds" value={formatMoney(s.refunded_minor, s.currency)} hint={`${s.refunded_count} refunded`} />
            <StatCard label="Est. store commission" value={formatMoney(s.est_fee_minor, s.currency)} hint="Estimate — see note" />
            <StatCard label="Est. net" value={formatMoney(s.gross_minor - s.est_fee_minor, s.currency)} hint="Payments − est. commission" />
            <StatCard label="Failed" value={s.failed_count} />
            <StatCard label="Pending" value={s.pending_count} />
          </div>
        </div>
      ))}

      <p className="text-[11px] text-muted-foreground px-1">
        Commission is an estimate using assumed rates (Google Play / Apple 15%, Razorpay 2%), not your provider's settlement reports.
        Refunds and failures are recorded from provider webhooks; refunding itself happens in Google Play Console / Razorpay, not here.
      </p>

      <Chips value={filter} onChange={setFilter} options={FILTERS} />

      {loading && rows.length === 0 ? <Spinner /> : rows.length === 0 ? <Empty>No transactions in this view.</Empty> : (
        <div className="bg-card rounded-2xl border border-border/60 divide-y divide-border/40 overflow-hidden">
          {rows.map((t) => (
            <div key={t.id} className="px-4 py-3 flex items-center gap-3">
              <div className="flex-1 min-w-0 space-y-0.5">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-foreground truncate">{t.username || t.email}</p>
                  <PlanBadge plan={t.plan} />
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {t.provider.replace("_", " ")} · {timeAgo(t.created_at)}{t.refunded_at ? ` · refunded ${timeAgo(t.refunded_at)}` : ""}
                </p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-sm font-semibold tabular-nums">{formatMoney(t.amount_minor, t.currency)}</p>
                <span className={cn("text-[10px] rounded-full px-2 py-0.5", STATUS_STYLE[t.status] ?? "bg-emerald-500/10 text-emerald-500")}>
                  {t.status.replace("_", " ")}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
      <Pager page={page} total={total} onPage={setPage} loading={loading} />
    </div>
  );
};

export default AdminPaymentsTab;

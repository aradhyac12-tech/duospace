import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { adminApi, formatBps, formatMoney, timeAgo, type AdminTransaction, type CommissionKey, type CommissionRate, type PaymentSummaryRow, type TxnFilter } from "@/lib/admin/adminApi";
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


const RATE_LABEL: Record<CommissionKey, string> = {
  google_play: "Google Play",
  apple: "Apple",
  razorpay: "Razorpay (incl. GST)",
  razorpay_subscription_extra: "Razorpay subscription extra",
};

/** Commission is an estimate; these are the rates it uses. Edit them to match your real contracts. */
const CommissionRates = () => {
  const { toast } = useToast();
  const [rates, setRates] = useState<CommissionRate[] | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);

  useEffect(() => {
    adminApi.getCommissionRates()
      .then((r) => { setRates(r); setDraft(Object.fromEntries(r.map((x) => [x.key, String(x.bps / 100)]))); })
      .catch(() => setRates([]));
  }, []);

  const save = async (r: CommissionRate, retained?: boolean) => {
    const pct = parseFloat(draft[r.key] ?? "");
    if (!Number.isFinite(pct) || pct < 0 || pct > 50) { toast({ title: "Enter a percentage between 0 and 50", variant: "destructive" }); return; }
    setSavingKey(r.key);
    try {
      await adminApi.setCommissionRate(r.key, Math.round(pct * 100), retained);
      setRates((prev) => prev && prev.map((x) => (x.key === r.key ? { ...x, bps: Math.round(pct * 100), retained_on_refund: retained ?? x.retained_on_refund } : x)));
      toast({ title: `${RATE_LABEL[r.key]} rate saved`, description: "Totals update next time you open this tab." });
    } catch (e) {
      toast({ title: "Couldn't save", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally { setSavingKey(null); }
  };

  if (!rates || rates.length === 0) return null;
  return (
    <details className="bg-card rounded-2xl border border-border/60 p-4">
      <summary className="text-sm font-medium text-foreground cursor-pointer">Commission rates used for estimates</summary>
      <div className="space-y-3 pt-3">
        {rates.filter((r) => r.key !== "apple").map((r) => (
          <div key={r.key} className="space-y-1.5">
            <div className="flex items-center gap-2">
              <p className="flex-1 text-xs text-foreground">{RATE_LABEL[r.key]} <span className="text-muted-foreground">· now {formatBps(r.bps)}</span></p>
              <Input
                className="w-20 h-8 text-right" inputMode="decimal" aria-label={`${RATE_LABEL[r.key]} percent`}
                value={draft[r.key] ?? ""} onChange={(e) => setDraft((d) => ({ ...d, [r.key]: e.target.value }))}
              />
              <span className="text-xs text-muted-foreground">%</span>
              <Button size="sm" variant="outline" disabled={savingKey === r.key} onClick={() => save(r)}>
                {savingKey === r.key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
              </Button>
            </div>
            {r.key !== "razorpay_subscription_extra" && (
              <label className="flex items-center justify-between text-[11px] text-muted-foreground">
                Provider keeps its fee when a payment is refunded
                <Switch checked={r.retained_on_refund} disabled={savingKey === r.key} onCheckedChange={(v) => save(r, v)} />
              </label>
            )}
            {r.note && <p className="text-[10px] text-muted-foreground/80">{r.note}</p>}
          </div>
        ))}
        <p className="text-[10px] text-muted-foreground">Estimates only — your provider's settlement reports are the source of truth.</p>
      </div>
    </details>
  );
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
            <StatCard
              label="Est. commission" value={formatMoney(s.est_fee_minor, s.currency)}
              hint={s.fee_kept_on_refunds_minor > 0 ? `incl. ${formatMoney(s.fee_kept_on_refunds_minor, s.currency)} kept on refunds` : "Estimate — rates below"}
            />
            <StatCard label="Est. net" value={formatMoney(s.gross_minor - s.est_fee_minor, s.currency)} hint="Payments − est. commission" />
            <StatCard label="Failed" value={s.failed_count} />
            <StatCard label="Pending" value={s.pending_count} />
          </div>
        </div>
      ))}

      <CommissionRates />

      <p className="text-[11px] text-muted-foreground px-1">
        Refunds and failures appear here once the provider's webhook records them. To refund someone, use Google Play Console or the Razorpay dashboard
        and search for the transaction id shown under each payment.
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
                {t.provider_transaction_id && (
                  <p className="text-[10px] text-muted-foreground/80 font-mono truncate select-all">{t.provider_transaction_id}</p>
                )}
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

import { useEffect, useState } from "react";
import { adminApi, type AdminOverview } from "@/lib/admin/adminApi";
import { useToast } from "@/hooks/use-toast";
import { Spinner, StatCard } from "./AdminBits";

const AdminOverviewTab = () => {
  const { toast } = useToast();
  const [data, setData] = useState<AdminOverview | null>(null);

  useEffect(() => {
    let live = true;
    adminApi.overview()
      .then((d) => { if (live) setData(d); })
      .catch((e) => toast({ title: "Couldn't load overview", description: e instanceof Error ? e.message : "", variant: "destructive" }));
    return () => { live = false; };
  }, [toast]);

  if (!data) return <Spinner />;
  const max = Math.max(1, ...data.signups_by_day.map((d) => d.count));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5">
        <StatCard label="Total users" value={data.total_users} hint={`+${data.new_7d} this week · +${data.new_30d} this month`} />
        <StatCard label="Active (24h)" value={data.active_24h} hint={`${data.active_7d} in the last 7 days`} />
        <StatCard label="Connected couples" value={data.linked_couples} hint="Both sides linked" />
        <StatCard label="No partner" value={data.solo_users} hint={data.one_way_links ? `${data.one_way_links} one-way link(s)` : undefined} />
        <StatCard label="Paying" value={data.paying_active} />
        <StatCard label="Founder / Beta" value={data.complimentary} />
        <StatCard label="Unverified email" value={data.unverified} />
        <StatCard label="Blocked" value={data.blocked} />
      </div>

      <div className="bg-card rounded-2xl border border-border/60 p-4">
        <p className="text-sm font-medium text-foreground mb-3">New sign-ups · last 14 days</p>
        <div className="flex items-end gap-1 h-24" role="img" aria-label="Sign-ups per day for the last 14 days">
          {data.signups_by_day.map((d) => (
            <div key={d.day} className="flex-1 flex flex-col items-center justify-end h-full gap-1">
              <div
                className="w-full rounded-t bg-accent/70 min-h-[2px]"
                style={{ height: `${Math.max(2, (d.count / max) * 100)}%` }}
                title={`${d.day}: ${d.count}`}
              />
            </div>
          ))}
        </div>
        <div className="flex justify-between text-[10px] text-muted-foreground mt-1.5">
          <span>{new Date(data.signups_by_day[0]?.day ?? Date.now()).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
          <span>Today</span>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground px-1">
        The console only shows account details — never messages, photos, calls or locations.
      </p>
    </div>
  );
};

export default AdminOverviewTab;

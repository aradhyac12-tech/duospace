import { adminApi, timeAgo } from "@/lib/admin/adminApi";
import { Empty, Spinner, useAdminList } from "./AdminBits";

const LABEL: Record<string, string> = {
  grant_founder: "Granted Founder", grant_beta: "Granted Beta", revoke_founder: "Revoked Founder", revoke_beta: "Revoked Beta",
  block_user: "Blocked account", unblock_user: "Unblocked account", verify_user: "Verified email",
  publish_announcement: "Published announcement", enable_announcement: "Re-enabled announcement",
  disable_announcement: "Hid announcement", set_app_update: "Changed app update settings",
};

const AdminActivityTab = () => {
  const { rows, loading } = useAdminList(() => adminApi.listAudit(100), []);
  if (loading && rows.length === 0) return <Spinner />;
  if (rows.length === 0) return <Empty>No admin actions yet.</Empty>;
  return (
    <div className="bg-card rounded-2xl border border-border/60 divide-y divide-border/40 overflow-hidden">
      {rows.map((r) => (
        <div key={r.id} className="px-4 py-3">
          <p className="text-sm text-foreground">
            {LABEL[r.action] ?? r.action}
            {r.target_username ? <span className="text-muted-foreground"> · {r.target_username}</span> : null}
          </p>
          <p className="text-[10px] text-muted-foreground">{timeAgo(r.created_at)}</p>
        </div>
      ))}
    </div>
  );
};

export default AdminActivityTab;

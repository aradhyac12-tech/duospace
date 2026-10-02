import { useState } from "react";
import { motion } from "framer-motion";
import PageHeader from "@/components/PageHeader";
import { cn } from "@/lib/utils";
import AdminOverviewTab from "@/components/admin/AdminOverviewTab";
import AdminUsersTab from "@/components/admin/AdminUsersTab";
import AdminCouplesTab from "@/components/admin/AdminCouplesTab";
import AdminAccessTab from "@/components/admin/AdminAccessTab";
import AdminPaymentsTab from "@/components/admin/AdminPaymentsTab";
import AdminAnnounceTab from "@/components/admin/AdminAnnounceTab";
import AdminActivityTab from "@/components/admin/AdminActivityTab";

/**
 * Admin console. Only reachable as ADMIN (Settings.tsx hides the row for
 * everyone else), but that is a convenience: the real gate is server-side.
 * Every RPC and the admin-user-action edge function independently re-check
 * "caller is the allowlisted ADMIN" in Postgres, so a modified client can
 * open this screen and still get nothing.
 *
 * Scope is ACCOUNT METADATA ONLY. Nothing here reads messages, media, calls
 * or locations, and nothing here can act as a user.
 */
const TABS = [
  { id: "overview", label: "Overview" },
  { id: "users", label: "Users" },
  { id: "couples", label: "Couples" },
  { id: "access", label: "Access" },
  { id: "payments", label: "Payments" },
  { id: "announce", label: "Announce" },
  { id: "activity", label: "Activity" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const AdminSettings = () => {
  const [tab, setTab] = useState<TabId>("overview");

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }}
      className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-24 bg-background"
    >
      <PageHeader title="Admin" subtitle="Users, access, payments & announcements" />

      <div className="border-b border-border/25">
        <div role="tablist" aria-label="Admin sections" className="flex gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden px-5 py-2.5">
          {TABS.map((t) => (
            <button
              key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
              className={cn(
                "shrink-0 text-xs font-medium rounded-full px-3.5 py-2 transition-colors",
                tab === t.id ? "bg-accent text-accent-foreground" : "bg-card text-muted-foreground border border-border/60",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="px-5 pt-4">
        {tab === "overview" && <AdminOverviewTab />}
        {tab === "users" && <AdminUsersTab />}
        {tab === "couples" && <AdminCouplesTab />}
        {tab === "access" && <AdminAccessTab />}
        {tab === "payments" && <AdminPaymentsTab />}
        {tab === "announce" && <AdminAnnounceTab />}
        {tab === "activity" && <AdminActivityTab />}
      </div>
    </motion.div>
  );
};

export default AdminSettings;

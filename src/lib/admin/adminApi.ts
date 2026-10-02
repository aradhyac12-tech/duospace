import { supabase } from "@/integrations/supabase/appClient";
import { invokeEdgeFunction } from "@/lib/edgeFunction";
import type { EntitlementPlan } from "@/lib/monetization/config";

/**
 * Thin typed wrappers over the admin_* RPCs (supabase/migrations/
 * 20261003100000_admin_console.sql). None of these decide anything: every RPC
 * re-checks "caller is the ADMIN plan" in Postgres, so a modified client gets
 * an error, not data. The generated Supabase types predate these functions,
 * hence the single untyped `.rpc` below (RLS/SECURITY DEFINER is the boundary,
 * not the TypeScript types).
 */
async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await (supabase as any).rpc(fn, args);
  if (error) throw new Error(error.message || `${fn} failed`);
  return data as T;
}

export type LinkState = "mutual" | "one_way" | "solo";
export type UserFilter = "all" | "linked" | "solo" | "one_way" | "unverified" | "blocked" | "paid" | "complimentary";
export type TxnFilter = "all" | "paid" | "refunded" | "failed" | "pending";
export type AnnouncementKind = "important_update" | "offer" | "announcement";
export type AnnouncementAudience = "all" | "free" | "paid" | "linked" | "solo";

export interface AdminOverview {
  total_users: number; new_7d: number; new_30d: number; active_24h: number; active_7d: number;
  linked_couples: number; solo_users: number; one_way_links: number; unverified: number; blocked: number;
  paying_active: number; complimentary: number;
  signups_by_day: { day: string; count: number }[];
}

export interface AdminUser {
  user_id: string; username: string | null; display_name: string | null; email: string; email_verified: boolean;
  created_at: string; last_seen_at: string | null; current_plan: EntitlementPlan;
  partner_user_id: string | null; partner_username: string | null; partner_display_name: string | null; partner_email: string | null;
  link_state: LinkState; blocked: boolean; block_reason: string | null; total_count: number;
}

export interface AdminCouple {
  link_state: Exclude<LinkState, "solo">;
  a_user_id: string; a_username: string | null; a_display_name: string | null; a_email: string; a_plan: EntitlementPlan; a_blocked: boolean;
  b_user_id: string; b_username: string | null; b_display_name: string | null; b_email: string; b_plan: EntitlementPlan; b_blocked: boolean;
  total_count: number;
}

export interface AdminGrant {
  entitlement_id: string; user_id: string; username: string | null; email: string; plan: EntitlementPlan; source: string;
  granted_by: string | null; granted_at: string;
  partner_user_id: string | null; partner_username: string | null; partner_email: string | null; link_state: LinkState;
}

export interface PaymentSummaryRow {
  currency: string; gross_minor: number; refunded_minor: number; est_fee_minor: number;
  paid_count: number; refunded_count: number; failed_count: number; pending_count: number;
}

export interface AdminTransaction {
  id: string; user_id: string; username: string | null; email: string; provider: string; plan: EntitlementPlan;
  amount_minor: number; currency: string; status: string; created_at: string; expires_at: string | null;
  refunded_at: string | null; est_fee_minor: number; total_count: number;
}

export interface AdminAnnouncement {
  id: string; kind: AnnouncementKind; title: string; body: string; audience: AnnouncementAudience;
  cta_label: string | null; cta_url: string | null; starts_at: string; expires_at: string | null;
  active: boolean; push_requested: boolean; created_at: string; dismissed_count: number;
}

export interface AppUpdateConfig {
  latest_version: string; min_supported_version: string; message: string | null;
  android_url: string | null; ios_url: string | null; updated_at: string;
}

export interface AuditRow {
  id: string; action: string; target_user_id: string | null; target_username: string | null;
  details: Record<string, unknown>; created_at: string;
}

export const adminApi = {
  overview: () => rpc<AdminOverview>("admin_overview"),
  listUsers: (query: string, filter: UserFilter, limit: number, offset: number) =>
    rpc<AdminUser[]>("admin_list_users", { _query: query || null, _filter: filter, _limit: limit, _offset: offset }),
  listCouples: (query: string, limit: number, offset: number) =>
    rpc<AdminCouple[]>("admin_list_couples", { _query: query || null, _limit: limit, _offset: offset }),
  listGrants: () => rpc<AdminGrant[]>("admin_list_grants"),
  /** Founder / Beta only - the server refuses ADMIN and every paid plan. */
  grant: async (userId: string, plan: "FOUNDER" | "BETA") => {
    const { error } = await supabase.rpc("grant_entitlement", { _target_user_id: userId, _plan: plan, _note: "granted from admin console" });
    if (error) throw new Error(error.message);
  },
  revoke: async (entitlementId: string) => {
    const { error } = await supabase.rpc("revoke_entitlement", { _entitlement_id: entitlementId });
    if (error) throw new Error(error.message);
  },
  paymentsSummary: () => rpc<PaymentSummaryRow[]>("admin_payments_summary"),
  listTransactions: (filter: TxnFilter, limit: number, offset: number) =>
    rpc<AdminTransaction[]>("admin_list_transactions", { _filter: filter, _limit: limit, _offset: offset }),
  listAnnouncements: () => rpc<AdminAnnouncement[]>("admin_list_announcements"),
  publishAnnouncement: (a: {
    kind: AnnouncementKind; title: string; body: string; audience: AnnouncementAudience;
    ctaLabel?: string; ctaUrl?: string; expiresAt?: string | null; push: boolean;
  }) =>
    rpc<string>("admin_publish_announcement", {
      _kind: a.kind, _title: a.title, _body: a.body, _audience: a.audience,
      _cta_label: a.ctaLabel || null, _cta_url: a.ctaUrl || null, _expires_at: a.expiresAt || null, _push: a.push,
    }),
  setAnnouncementActive: (id: string, active: boolean) => rpc<void>("admin_set_announcement_active", { _id: id, _active: active }),
  getAppUpdate: async (): Promise<AppUpdateConfig | null> => {
    const { data } = await (supabase as any).from("app_update_config").select("*").maybeSingle();
    return (data as AppUpdateConfig | null) ?? null;
  },
  setAppUpdate: (c: { latest: string; minSupported: string; message?: string; androidUrl?: string; iosUrl?: string }) =>
    rpc<void>("admin_set_app_update", {
      _latest: c.latest, _min_supported: c.minSupported, _message: c.message || null,
      _android_url: c.androidUrl || null, _ios_url: c.iosUrl || null,
    }),
  listAudit: (limit = 50) => rpc<AuditRow[]>("admin_list_audit", { _limit: limit }),

  /** block / unblock / verify go through the edge function (needs the Auth admin API). */
  userAction: (action: "block" | "unblock" | "verify", userId: string, reason?: string) =>
    invokeEdgeFunction<{ ok: boolean }>("admin-user-action", { body: { action, userId, reason } }),
};

/** 14900 -> "₹149.00" (falls back to "INR 149.00" if the currency code is unknown to Intl). */
export function formatMoney(minor: number, currency: string): string {
  const major = (minor ?? 0) / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(major);
  } catch {
    return `${currency} ${major.toFixed(2)}`;
  }
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

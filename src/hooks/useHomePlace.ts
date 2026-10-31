/**
 * useHomePlace — the signed-in user's saved Home (pin + radius) and the
 * partner's coarse "at home" status.
 *
 * The arrival detection itself runs in the database (a trigger on `locations`,
 * see supabase/migrations/20261018120000_home_places_arrival_alerts.sql), so it
 * keeps working when this screen is closed. This hook only reads/writes the
 * settings and shows status.
 *
 * Privacy: the partner's status comes from get_partner_home_status(), which
 * never exposes coordinates, address or radius.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/appClient";

export interface HomePlace {
  id: string;
  label: string;
  address: string | null;
  latitude: number;
  longitude: number;
  radius_m: number;
  notify_partner: boolean;
  notify_leave: boolean;
  is_inside: boolean;
  last_arrived_at: string | null;
  last_left_at: string | null;
}

export interface HomeDraft {
  label: string;
  address: string | null;
  latitude: number;
  longitude: number;
  radius_m: number;
  notify_partner: boolean;
  notify_leave: boolean;
}

export interface PartnerHomeStatus {
  label: string;
  is_inside: boolean;
  last_arrived_at: string | null;
  last_left_at: string | null;
}

export const HOME_MIN_RADIUS_M = 50;
export const HOME_MAX_RADIUS_M = 1000;
export const HOME_DEFAULT_RADIUS_M = 150;

// The generated Database types don't know this table yet.
const db = supabase as any;

export function useHomePlace(userId: string | null, partnerId: string | null) {
  const [home, setHome] = useState<HomePlace | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [partnerHome, setPartnerHome] = useState<PartnerHomeStatus | null>(null);
  const lastPartnerFetch = useRef(0);

  useEffect(() => {
    let alive = true;
    if (!userId) { setHome(null); setLoading(false); return; }
    setLoading(true);
    db.from("home_places").select("*").eq("user_id", userId).maybeSingle()
      .then(({ data }: { data: HomePlace | null }) => { if (alive) { setHome(data ?? null); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [userId]);

  const refreshPartnerHome = useCallback(async (force = false) => {
    if (!userId || !partnerId) { setPartnerHome(null); return; }
    const now = Date.now();
    if (!force && now - lastPartnerFetch.current < 20_000) return;
    lastPartnerFetch.current = now;
    try {
      const { data, error } = await db.rpc("get_partner_home_status");
      if (error) return;
      const row = Array.isArray(data) ? data[0] : data;
      setPartnerHome(row ?? null);
    } catch { /* keep the previous status */ }
  }, [userId, partnerId]);

  useEffect(() => {
    void refreshPartnerHome(true);
    if (!userId || !partnerId) return;
    const id = window.setInterval(() => { if (!document.hidden) void refreshPartnerHome(true); }, 60_000);
    const onVis = () => { if (!document.hidden) void refreshPartnerHome(true); };
    document.addEventListener("visibilitychange", onVis);
    return () => { window.clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, [userId, partnerId, refreshPartnerHome]);

  const save = useCallback(async (draft: HomeDraft): Promise<{ ok: boolean; error?: string }> => {
    if (!userId) return { ok: false, error: "Not signed in" };
    setSaving(true);
    try {
      const { data, error } = await db.from("home_places").upsert({
        user_id: userId,
        label: draft.label.trim() || "Home",
        address: draft.address?.trim() || null,
        latitude: draft.latitude,
        longitude: draft.longitude,
        radius_m: Math.round(Math.min(HOME_MAX_RADIUS_M, Math.max(HOME_MIN_RADIUS_M, draft.radius_m))),
        notify_partner: draft.notify_partner,
        notify_leave: draft.notify_partner && draft.notify_leave,
      }, { onConflict: "user_id" }).select("*").single();
      if (error) return { ok: false, error: error.message };
      setHome(data as HomePlace);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Couldn't save" };
    } finally {
      setSaving(false);
    }
  }, [userId]);

  const remove = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    if (!userId) return { ok: false, error: "Not signed in" };
    setSaving(true);
    try {
      const { error } = await db.from("home_places").delete().eq("user_id", userId);
      if (error) return { ok: false, error: error.message };
      setHome(null);
      return { ok: true };
    } finally {
      setSaving(false);
    }
  }, [userId]);

  return { home, loading, saving, save, remove, partnerHome, refreshPartnerHome };
}

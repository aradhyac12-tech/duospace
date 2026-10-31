/**
 * useHomeTrip — "I'm heading home" (safe arrival).
 *
 * Own side: start / cancel an active trip. Partner side: their coarse trip
 * status (distance + rough ETA, never coordinates) via get_partner_trip().
 * Progress, stall detection and the arrival push all run in the database (see
 * supabase/migrations/20261018140000_home_trips_safe_arrival.sql); this hook
 * only starts/cancels and polls status.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/appClient";

export interface OwnTrip {
  id: string;
  started_at: string;
  last_distance_m: number | null;
}

export interface PartnerTrip {
  started_at: string;
  distance_m: number | null;
  eta_min: number | null;
  stalled: boolean;
  last_update_at: string | null;
}

// The generated Database types don't know these tables/functions yet.
const db = supabase as any;

export function useHomeTrip(userId: string | null, partnerId: string | null, hasHome: boolean) {
  const [trip, setTrip] = useState<OwnTrip | null>(null);
  const [partnerTrip, setPartnerTrip] = useState<PartnerTrip | null>(null);
  const [busy, setBusy] = useState(false);
  const lastPartnerFetch = useRef(0);

  const refreshOwn = useCallback(async () => {
    if (!userId || !hasHome) { setTrip(null); return; }
    try {
      const { data } = await db.from("home_trips").select("id, started_at, last_distance_m")
        .eq("user_id", userId).eq("status", "active").maybeSingle();
      setTrip((data as OwnTrip | null) ?? null);
    } catch { /* keep the previous value */ }
  }, [userId, hasHome]);

  const refreshPartnerTrip = useCallback(async (force = false) => {
    if (!userId || !partnerId) { setPartnerTrip(null); return; }
    const now = Date.now();
    if (!force && now - lastPartnerFetch.current < 10_000) return;
    lastPartnerFetch.current = now;
    try {
      const { data, error } = await db.rpc("get_partner_trip");
      if (error) return;
      const row = Array.isArray(data) ? data[0] : data;
      setPartnerTrip((row as PartnerTrip | null) ?? null);
    } catch { /* keep the previous value */ }
  }, [userId, partnerId]);

  // Poll while the screen is visible; the server ends trips itself (arrived /
  // expired), so a periodic re-read is what clears the card.
  useEffect(() => {
    void refreshOwn();
    void refreshPartnerTrip(true);
    if (!userId) return;
    const tick = () => { if (!document.hidden) { void refreshOwn(); void refreshPartnerTrip(true); } };
    const id = window.setInterval(tick, 15_000);
    document.addEventListener("visibilitychange", tick);
    return () => { window.clearInterval(id); document.removeEventListener("visibilitychange", tick); };
  }, [userId, refreshOwn, refreshPartnerTrip]);

  const start = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    if (!userId) return { ok: false, error: "Not signed in" };
    setBusy(true);
    try {
      const { data, error } = await db.from("home_trips").insert({ user_id: userId }).select("id, started_at, last_distance_m").single();
      if (error) return { ok: false, error: error.message };
      setTrip(data as OwnTrip);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Couldn't start" };
    } finally {
      setBusy(false);
    }
  }, [userId]);

  const cancel = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    if (!userId || !trip) return { ok: false };
    setBusy(true);
    try {
      const { error } = await db.from("home_trips").update({ status: "cancelled" }).eq("id", trip.id);
      if (error) return { ok: false, error: error.message };
      setTrip(null);
      return { ok: true };
    } finally {
      setBusy(false);
    }
  }, [userId, trip]);

  return { trip, partnerTrip, busy, start, cancel, refreshPartnerTrip };
}

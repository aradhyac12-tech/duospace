import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/appClient";
import { useAuth } from "@/hooks/useAuth";
import { getCachedPartner } from "@/lib/partnerCache";

/**
 * KI-23: lip reading analyses the PARTNER's face on this device. It stays on-device and the text
 * is never stored, but the partner must be told. While `active` is true this announces it over the
 * couple-scoped, private `lipread:<uid1>:<uid2>` broadcast channel (authorised by
 * is_couple_realtime_topic_authorized, migration 20261001160000) and returns whether the PARTNER is
 * currently doing it to US so the call screen can show a banner.
 *
 * Heartbeat every 5 s while active; the receiver treats silence for 12 s as "stopped", so a crash,
 * dropped connection or killed app never leaves a stale banner. Best-effort by design: a failure
 * to announce never blocks lip reading itself (it is the viewer's own on-device feature).
 */
const HEARTBEAT_MS = 5_000;
const STALE_MS = 12_000;

export function useLipReadingNotice(active: boolean): { partnerLipReading: boolean } {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [partnerId, setPartnerId] = useState<string | null>(() => (userId ? getCachedPartner(userId)?.partnerId ?? null : null));
  const [partnerLipReading, setPartnerLipReading] = useState(false);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const readyRef = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  const staleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Resolve the partner id (cache first, then own profile row).
  useEffect(() => {
    if (!userId) { setPartnerId(null); return; }
    const cached = getCachedPartner(userId)?.partnerId ?? null;
    if (cached) { setPartnerId(cached); return; }
    let cancelled = false;
    void supabase.from("profiles").select("partner_id").eq("user_id", userId).single()
      .then(({ data }) => { if (!cancelled) setPartnerId(data?.partner_id ?? null); });
    return () => { cancelled = true; };
  }, [userId]);

  // One channel per call screen: receive always, send while active.
  useEffect(() => {
    if (!userId || !partnerId) return;
    const name = [userId, partnerId].sort().join(":");
    const ch = supabase.channel(`lipread:${name}`, { config: { private: true } });
    ch
      .on("broadcast", { event: "lipread" }, (msg) => {
        if (msg.payload?.user_id !== partnerId) return;
        if (staleTimer.current) clearTimeout(staleTimer.current);
        if (msg.payload?.active) {
          setPartnerLipReading(true);
          staleTimer.current = setTimeout(() => setPartnerLipReading(false), STALE_MS);
        } else {
          setPartnerLipReading(false);
        }
      })
      .subscribe((status) => {
        readyRef.current = status === "SUBSCRIBED";
        if (readyRef.current && activeRef.current) {
          void ch.send({ type: "broadcast", event: "lipread", payload: { user_id: userId, active: true } });
        }
      });
    channelRef.current = ch;
    return () => {
      if (readyRef.current && activeRef.current) {
        // Best effort "stopped" before teardown; the receiver's stale timer is the backstop.
        void ch.send({ type: "broadcast", event: "lipread", payload: { user_id: userId, active: false } });
      }
      readyRef.current = false;
      channelRef.current = null;
      if (staleTimer.current) clearTimeout(staleTimer.current);
      setPartnerLipReading(false);
      supabase.removeChannel(ch);
    };
  }, [userId, partnerId]);

  // Announce on/off + heartbeat while active.
  useEffect(() => {
    if (!userId) return;
    const send = (isActive: boolean) => {
      const ch = channelRef.current;
      if (!ch || !readyRef.current) return;
      void ch.send({ type: "broadcast", event: "lipread", payload: { user_id: userId, active: isActive } });
    };
    if (!active) { send(false); return; }
    send(true);
    const t = setInterval(() => send(true), HEARTBEAT_MS);
    return () => clearInterval(t);
  }, [active, userId, partnerId]);

  return { partnerLipReading };
}

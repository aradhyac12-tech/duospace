import PageHeader from "@/components/PageHeader";
import { motion } from "framer-motion";
import { ChevronRight, Settings as SettingsIcon, Heart, Link2, ShieldCheck, ShieldAlert, Loader2 } from "lucide-react";
import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useTheme } from "@/contexts/ThemeContext";
import { hapticSelection } from "@/lib/haptics";

/**
 * Profile — the clean entry point for identity: partner identity, your own
 * account identity, a security-at-a-glance, and Settings. Everything else
 * (theme, privacy toggles, notifications, backups, ...) stays behind the
 * single "Settings" row, so this screen never grows into a second settings
 * page. Feature-hub items (Gallery, Music, Map, Shayari, Love Letter,
 * Memories, ...) live in their own hub and are deliberately not duplicated
 * here.
 */
const Profile = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { appSettings, appIcon, appName } = useTheme();
  const [partnerName, setPartnerName] = useState("");
  const [partnerAvatar, setPartnerAvatar] = useState<string | null>(null);
  const [partnerLinked, setPartnerLinked] = useState<boolean | null>(null);
  const [partnerLoadFailed, setPartnerLoadFailed] = useState(false);
  const [myName, setMyName] = useState("");

  // Same query Chat.tsx uses to resolve the partner — kept intentionally
  // separate (not a shared hook) so this page has zero effect on Chat's
  // already-working data flow. partnerLinked stays null (loading) until
  // the query settles, and a failed query is surfaced instead of silently
  // reading as "not linked".
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    supabase.from("profiles").select("display_name,partner_id").eq("user_id", user.id).single()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) { setPartnerLoadFailed(true); setPartnerLinked(false); return; }
        if (data?.display_name) setMyName(data.display_name);
        if (data?.partner_id) {
          setPartnerLinked(true);
          supabase.from("profiles").select("display_name,avatar_url,pet_name").eq("user_id", data.partner_id).single()
            .then(({ data: pp }) => {
              if (cancelled) return;
              if (pp) { setPartnerName(pp.pet_name || pp.display_name || "Partner"); setPartnerAvatar(pp.avatar_url); }
            });
        } else {
          setPartnerLinked(false);
        }
      });
    return () => { cancelled = true; };
  }, [user]);

  const daysTogether = appSettings.anniversaryDate
    ? Math.max(0, Math.floor((Date.now() - new Date(appSettings.anniversaryDate).getTime()) / 86400000))
    : null;

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <PageHeader title="Profile" />

      <div className="flex flex-col items-center px-6 pt-6 pb-8">
        <div className="h-24 w-24 rounded-full bg-muted flex items-center justify-center overflow-hidden">
          {partnerLinked === null ? (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          ) : partnerAvatar ? (
            <img src={partnerAvatar} alt="" className="h-full w-full object-cover" />
          ) : appIcon ? (
            <img src={appIcon} alt={appName} className="h-full w-full object-cover" />
          ) : (
            <span className="text-2xl font-semibold text-muted-foreground">
              {(partnerLinked ? partnerName : appName)?.slice(0, 2).toUpperCase()}
            </span>
          )}
        </div>

        <h1 className="text-lg font-semibold text-foreground mt-4">
          {partnerLinked === null ? "\u00A0" : partnerLinked ? partnerName || "Partner" : "No partner linked yet"}
        </h1>

        <p className="text-[12px] text-muted-foreground mt-1 flex items-center gap-1.5">
          {partnerLinked === null ? (
            "Loading…"
          ) : partnerLoadFailed ? (
            "Couldn't load — check your connection"
          ) : partnerLinked ? (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
              Connected
            </>
          ) : (
            <>
              <Link2 className="h-3 w-3" aria-hidden="true" />
              Link a partner from Settings
            </>
          )}
        </p>

        {partnerLinked && daysTogether !== null && (
          <motion.div
            initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}
            className="glass-subtle flex items-center gap-2 mt-5 px-4 py-2.5 rounded-2xl"
          >
            <Heart className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
            <span className="text-[12px] text-foreground">
              Together for <span className="font-semibold">{daysTogether.toLocaleString()}</span> {daysTogether === 1 ? "day" : "days"}
            </span>
          </motion.div>
        )}
      </div>

      <div className="px-5 pb-8 space-y-2">
        {/* Account identity — who's signed in on this device */}
        <div className="w-full flex items-center gap-3 px-4 py-3.5 rounded-2xl bg-card/70 border border-border/25">
          <span className="h-9 w-9 rounded-full bg-muted flex items-center justify-center shrink-0 text-xs font-semibold text-foreground/80">
            {(myName || user?.email || "?").slice(0, 2).toUpperCase()}
          </span>
          <span className="flex-1 min-w-0">
            <span className="block text-sm font-medium text-foreground truncate">{myName || "You"}</span>
            <span className="block text-[11px] text-muted-foreground truncate">{user?.email || "Signed in"}</span>
          </span>
        </div>

        {/* Security at a glance */}
        <button
          onClick={() => { hapticSelection(); navigate("/settings/security"); }}
          className="w-full flex items-center gap-3 px-4 py-3.5 rounded-2xl bg-card/70 border border-border/25 active:scale-[0.99] transition-transform min-h-11"
        >
          <span className="h-9 w-9 rounded-full bg-muted flex items-center justify-center shrink-0">
            {appSettings.biometricLock
              ? <ShieldCheck className="h-[18px] w-[18px] text-foreground/80" aria-hidden="true" />
              : <ShieldAlert className="h-[18px] w-[18px] text-warning" aria-hidden="true" />}
          </span>
          <span className="flex-1 text-left">
            <span className="block text-sm font-medium text-foreground">Security</span>
            <span className="block text-[11px] text-muted-foreground">{appSettings.biometricLock ? "App Lock on" : "App Lock off"}</span>
          </span>
          <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        </button>

        <button
          onClick={() => { hapticSelection(); navigate("/settings"); }}
          className="w-full flex items-center gap-3 px-4 py-3.5 rounded-2xl bg-card/70 border border-border/25 active:scale-[0.99] transition-transform min-h-11"
        >
          <span className="h-9 w-9 rounded-full bg-muted flex items-center justify-center shrink-0">
            <SettingsIcon className="h-[18px] w-[18px] text-foreground/80" aria-hidden="true" />
          </span>
          <span className="flex-1 text-left">
            <span className="block text-sm font-medium text-foreground">Settings</span>
            <span className="block text-[11px] text-muted-foreground">Theme, privacy, notifications & more</span>
          </span>
          <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
};

export default Profile;

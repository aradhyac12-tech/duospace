import { motion } from "framer-motion";
import { useTheme } from "@/contexts/ThemeContext";
import {
  ChevronLeft, Search, User, Heart, Smartphone, ShieldCheck, Palette,
  CalendarHeart, CloudUpload, MessageSquare, LogOut, Loader2, Bell, Languages,
} from "lucide-react";
import { useNavigate, useLocation } from "react-router-dom";
import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/appClient";
import { useAuth } from "@/hooks/useAuth";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { hapticMedium } from "@/lib/haptics";
import SettingsHubRow from "@/components/settings/SettingsHubRow";
import ConfirmActionDialog from "@/components/settings/ConfirmActionDialog";
import { getDeviceId } from "@/lib/deviceId";
import { APP_VERSION } from "@/lib/errors";
import { getLanguageCode, getSplashLanguage } from "@/lib/i18n";

// TOKEN LIFECYCLE (item 10) — deactivates this device's push tokens before
// actually signing out. Clearing profiles.push_token triggers
// sync_push_token_to_push_tokens()'s new invalidation branch (see
// 20260808150000_call_hardening.sql) for the regular FCM/APNs token; the
// VoIP token is deactivated directly by device_id since it's registered
// straight into push_tokens rather than synced from a profiles column.
// Best-effort throughout — a failed cleanup call must never block sign-out
// itself, since staying signed in is worse than a stale token row.
// Unchanged from the pre-redesign implementation — no auth behavior here
// was touched during this pass.
async function signOutAndClearPushTokens(): Promise<void> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      await supabase.from("profiles").update({ push_token: null, push_platform: null }).eq("user_id", user.id);
      const deviceId = await getDeviceId();
      await supabase.from("push_tokens").update({
        is_valid: false, invalidated_reason: "signed_out",
      } as never).eq("user_id", user.id).eq("device_id", deviceId);
    }
  } catch {
    /* best-effort — sign-out must proceed regardless */
  }
  await supabase.auth.signOut();
}

/**
 * Settings hub — Phase 6 redesign. Each former "giant collapsible section"
 * is now a one-line summary row that either opens a dedicated subview page
 * (Partner, Devices, Security, Appearance, Data & Backup, Import — these
 * have real workflows: network calls, multi-step flows, or destructive
 * actions) or a short sheet/dialog right here (Account, Anniversary — a
 * couple of fields and a button). Nothing about auth, crypto, or the
 * underlying handlers changed; this file only changed what's visible at
 * once and where each piece of UI lives.
 */
const Settings = () => {
  const { appSettings, updateSetting } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const { toast } = useToast();

  const [searchQuery, setSearchQuery] = useState("");
  const [showAccountSheet, setShowAccountSheet] = useState(false);
  const [showAnniversaryDialog, setShowAnniversaryDialog] = useState(false);
  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const [usernameInput, setUsernameInput] = useState("");
  const [savingUsername, setSavingUsername] = useState(false);
  const [partnerLinked, setPartnerLinked] = useState<boolean | null>(null);
  const [partnerName, setPartnerName] = useState("");
  const [pendingRequestCount, setPendingRequestCount] = useState(0);

  // A deep link (?invite=CODE) used to auto-open a dialog on this page —
  // that flow now lives entirely on the Partner subview, so just forward
  // there with the code intact instead of duplicating invite-acceptance UI.
  useEffect(() => {
    const invite = new URLSearchParams(location.search).get("invite");
    if (invite) navigate(`/settings/partner${location.search}`, { replace: true });
  }, [location.search, navigate]);

  useEffect(() => {
    if (!user) return;
    supabase.from("profiles")
      .select("username,partner_id")
      .eq("user_id", user.id).single()
      .then(({ data }) => {
        if (data?.username) setUsernameInput(data.username);
        setPartnerLinked(!!data?.partner_id);
        if (data?.partner_id) {
          supabase.from("profiles").select("display_name").eq("user_id", data.partner_id).single()
            .then(({ data: pp }) => { if (pp) setPartnerName(pp.display_name || "Partner"); });
        }
      });

    supabase.from("partner_requests" as any)
      .select("id", { count: "exact", head: true })
      .eq("status", "pending").eq("receiver_id", user.id)
      .then(({ count }) => setPendingRequestCount(count || 0));
  }, [user]);

  const saveUsername = async () => {
    if (!user || !usernameInput.trim() || savingUsername) return;
    const clean = usernameInput.trim().toLowerCase().replace(/[^a-z0-9_.]/g, "");
    if (clean.length < 3) { toast({ title: "Username too short (min 3 chars)", variant: "destructive" }); return; }
    setSavingUsername(true);
    const { error } = await supabase.from("profiles").update({ username: clean }).eq("user_id", user.id);
    setSavingUsername(false);
    if (error?.code === "23505") toast({ title: "Username taken", variant: "destructive" });
    else if (error) toast({ title: "Error", description: "Check your connection and try again.", variant: "destructive" });
    else { setUsernameInput(clean); toast({ title: "Username saved" }); }
  };

  const handleSignOut = async () => {
    if (signingOut) return; // guards duplicate taps while the round-trip is in flight
    setSigningOut(true);
    hapticMedium();
    try {
      await signOutAndClearPushTokens();
      // No navigation call needed — losing the session flips ProtectedRoutes
      // to the Auth screen automatically. If sign-out itself throws (e.g.
      // fully offline), surface it and let the user retry instead of
      // silently doing nothing.
    } catch (err) {
      setSigningOut(false);
      toast({ title: "Couldn't sign out", description: "Check your connection and try again.", variant: "destructive" });
    }
  };

  const q = searchQuery.trim().toLowerCase();
  const matches = (keywords: string) => !q || keywords.toLowerCase().includes(q);

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }}
      className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-24 bg-background"
      style={{ WebkitOverflowScrolling: "touch" as any }}
    >
      <header className="safe-top px-5 pt-4 pb-3 sticky top-0 z-20 bg-background/85 backdrop-blur-xl border-b border-border/40">
        <div className="flex items-center gap-3 mb-3">
          <button onClick={() => { navigate(-1); }} className="h-10 w-10 rounded-full bg-accent/15 flex items-center justify-center active:scale-95 transition-transform" aria-label="Back">
            <ChevronLeft className="h-5 w-5 text-accent" />
          </button>
          <h1 className="text-lg font-semibold tracking-tight flex-1">Settings</h1>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search settings"
            className="h-9 pl-8 rounded-full bg-muted/60 border-transparent text-sm"
            aria-label="Search settings"
          />
        </div>
      </header>

      <div className="px-5 space-y-2 pt-5">
        {matches("account sign out logout email username profile handle") && (
          <SettingsHubRow
            icon={User} label="Account"
            summary={user?.email || "Username & sign out"}
            onClick={() => setShowAccountSheet(true)}
          />
        )}

        {matches("partner invite link username code request connect unlink pairing pair") && (
          <SettingsHubRow
            icon={Heart} label="Partner"
            summary={partnerLinked === null ? "Loading…" : partnerLinked ? `Connected — ${partnerName}` : "Not connected yet"}
            badge={pendingRequestCount}
            onClick={() => navigate("/settings/partner")}
          />
        )}

        {matches("device qr scan sign in another new account invite signup pair recent history session passkey where signed") && (
          <SettingsHubRow
            icon={Smartphone} label="Devices & Sign-in"
            summary="QR sign-in, passkeys, recent devices"
            onClick={() => navigate("/settings/devices")}
          />
        )}

        {matches("security privacy lock pin biometric fingerprint face haptic notification mood peek guard") && (
          <SettingsHubRow
            icon={ShieldCheck} label="Security & Privacy"
            summary={appSettings.biometricLock ? "App Lock on" : "App Lock off"}
            tone={appSettings.biometricLock ? "default" : "warning"}
            onClick={() => navigate("/settings/security")}
          />
        )}

        {matches("notification sound ringtone call ring haptic vibrate vibration chime pop marimba background push") && (
          <SettingsHubRow
            icon={Bell} label="Notifications"
            summary="Message sound, call ringtone & haptics"
            onClick={() => navigate("/settings/notifications")}
          />
        )}

        {matches("appearance theme color wallpaper icon name dark light auto schedule time adaptive dynamic sky") && (
          <SettingsHubRow
            icon={Palette} label="Appearance"
            summary="Theme, wallpaper, app icon & name"
            onClick={() => navigate("/settings/appearance")}
          />
        )}

        {/* PHASE 3 FIX (splash continuity): this used to be the splash's
            only language entry point — removed from there per the redesign
            brief ("language belongs in Settings → Language, not the
            hand-off frame"), but no actual replacement row existed here
            until now, leaving language preference with no UI at all past
            first-run device-locale detection. lib/i18n.ts's own comment
            already anticipated this ("future Settings > Language") — this
            just builds it, reusing the same storage-backed
            getLanguageCode/setLanguageCode/SPLASH_LANGUAGES this file
            already exported for exactly this purpose. */}
        {matches("language locale translate translation region idioma français deutsch") && (
          <SettingsHubRow
            icon={Languages} label="Language"
            summary={getSplashLanguage(getLanguageCode()).label}
            onClick={() => navigate("/settings/language")}
          />
        )}

        {matches("anniversary date love") && (
          <SettingsHubRow
            icon={CalendarHeart} label="Anniversary"
            summary={appSettings.anniversaryDate ? new Date(appSettings.anniversaryDate).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "Not set"}
            onClick={() => setShowAnniversaryDialog(true)}
          />
        )}

        {matches("data backup cloud sync recovery restore key daily") && (
          <SettingsHubRow
            icon={CloudUpload} label="Data & Backup"
            summary="Cloud backup, restore & call keys"
            onClick={() => navigate("/settings/data")}
          />
        )}

        {matches("whatsapp import chat history") && (
          <SettingsHubRow
            icon={MessageSquare} label="Import"
            summary="Bring in a WhatsApp chat export"
            onClick={() => navigate("/settings/import")}
          />
        )}
      </div>

      {/* App version — bumped every release per docs/rules.md's version-bump
          rule, so this always reflects the build actually running. */}
      <p className="text-center text-[11px] text-muted-foreground py-4">
        DuoSpace v{APP_VERSION}
      </p>

      {/* Account sheet — short, so it stays inline rather than a full page */}
      <Dialog open={showAccountSheet} onOpenChange={setShowAccountSheet}>
        <DialogContent className="rounded-2xl max-w-[360px]">
          <DialogHeader>
            <DialogTitle className="text-base">Account</DialogTitle>
            <DialogDescription>{user?.email}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="bg-muted/40 rounded-2xl p-4 space-y-2">
              <p className="text-[11px] font-medium text-muted-foreground">Username</p>
              <div className="flex gap-2">
                <Input value={usernameInput} onChange={e => setUsernameInput(e.target.value.toLowerCase().replace(/[^a-z0-9_.]/g, ""))}
                  placeholder="username" className="h-9 rounded-xl flex-1 text-sm" />
                <Button onClick={saveUsername} disabled={savingUsername} size="sm" className="rounded-xl bg-primary text-primary-foreground h-9 px-4 text-xs">
                  {savingUsername ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground">Letters, numbers, . and _ only. Min 3 characters.</p>
            </div>
            <button
              onClick={() => { setShowAccountSheet(false); setShowSignOutConfirm(true); }}
              className="w-full bg-card rounded-xl border border-border/60 p-3 text-sm text-destructive text-center active:scale-[0.98] transition-transform flex items-center justify-center gap-1.5"
            >
              <LogOut className="h-3.5 w-3.5" /> Sign Out
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmActionDialog
        open={showSignOutConfirm}
        onOpenChange={(v) => { if (!signingOut) setShowSignOutConfirm(v); }}
        title="Sign out?"
        whatHappens="You'll be signed out of DuoSpace on this device and returned to the sign-in screen."
        dataAffected="This device stops receiving message and call push notifications immediately — its notification token is invalidated on our servers as part of sign-out. Nothing is deleted from your account."
        reversible={true}
        reversibleNote="sign back in anytime with your credentials, passkey, or QR"
        authRequired={false}
        confirmLabel={signingOut ? "Signing out…" : "Sign Out"}
        onConfirm={handleSignOut}
      />

      {/* Anniversary — one field, stays a dialog */}
      <Dialog open={showAnniversaryDialog} onOpenChange={setShowAnniversaryDialog}>
        <DialogContent className="rounded-2xl max-w-[320px]">
          <DialogHeader>
            <DialogTitle className="text-base">Anniversary</DialogTitle>
            <DialogDescription>Your special date 💕</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <input type="date" value={appSettings.anniversaryDate || ""}
              onChange={e => { updateSetting("anniversaryDate", e.target.value || null); if (e.target.value) toast({ title: "Anniversary saved 💕" }); }}
              className="w-full h-9 rounded-xl border border-border/60 bg-muted/30 px-3 text-sm" />
            {appSettings.anniversaryDate && (
              <button onClick={() => { updateSetting("anniversaryDate", null); }} className="text-[11px] text-destructive">Remove</button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
};

export default Settings;

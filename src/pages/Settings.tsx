import { motion, AnimatePresence } from "framer-motion";
import { useTheme, ThemeColor, THEMES } from "@/contexts/ThemeContext";
import { WALLPAPERS, resolveWallpaperStyle } from "@/lib/wallpapers";
import {
  ChevronLeft, Check, ImageIcon, X, Bell, Fingerprint, Vibrate, Link2, Unlink,
  EyeOff, Copy, Share2, Eye, ChevronRight, ChevronDown, Palette, Download, RotateCcw,
  MessageSquare, Upload, Scan, KeyRound, Smartphone, Image,
  Pencil, Search, UserPlus, Smile, QrCode, Sun, Moon, MonitorSmartphone, Clock, Sparkles,
  ChevronsDownUp, ChevronsUpDown, Wand2,
} from "lucide-react";
import CodeSurpriseEditor from "@/components/CodeSurpriseEditor";
import { useLocation, useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import { useState, useEffect, useMemo, useRef, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Slider } from "@/components/ui/slider";
import { hapticLight, hapticMedium, hapticSelection, getHapticIntensity, setHapticIntensity, type HapticIntensity } from "@/lib/haptics";
import storage from "@/lib/storage";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { hashPin, verifyPin } from "@/lib/crypto";
import BackupManager from "@/components/BackupManager";
import DailyKeyManager from "@/components/DailyKeyManager";
import RecentDevices from "@/components/RecentDevices";
import ThemeStudio from "@/components/ThemeStudio";
import IconStudio from "@/components/IconStudio";
import PeekConfigDialog from "@/components/PeekConfigDialog";
import MoodHistory from "@/components/MoodHistory";
import QRSignInDisplay from "@/components/auth/QRSignInDisplay";
import QRSignInScanner from "@/components/auth/QRSignInScanner";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import PasskeyRegister from "@/components/auth/PasskeyRegister";
import AddEmailPasswordDialog from "@/components/auth/AddEmailPasswordDialog";


// Every collapsible top-level section on this page, in display order.
// Keep this in sync with the <SectionShell id="..."> ids below — it drives
// persisted collapse state and the "expand all / collapse all" button.
const SETTINGS_SECTION_IDS = [
  "account", "partner", "devices", "security", "appearance",
  "anniversary", "data", "whatsapp",
] as const;

/**
 * A titled, collapsible section. Renders nothing when the current search
 * query doesn't match `keywords` (same behavior the page had before this
 * was factored out). While searching, sections are always shown expanded
 * — collapse state only applies when the user isn't actively filtering.
 */
const SectionShell = ({
  id, title, keywords, matches, isOpen, isSearching, onToggle, children,
}: {
  id: string;
  title: string;
  keywords: string;
  matches: (keywords: string) => boolean;
  isOpen: boolean;
  isSearching: boolean;
  onToggle: (id: string) => void;
  children: ReactNode;
}) => {
  if (!matches(keywords)) return null;
  const open = isSearching || isOpen;
  return (
    <section>
      <button
        type="button"
        onClick={() => onToggle(id)}
        aria-expanded={open}
        disabled={isSearching}
        className={cn(
          "w-full flex items-center justify-between gap-2 mb-2.5 sticky top-[112px] z-10 backdrop-blur-sm transition-transform active:scale-[0.99] disabled:active:scale-100",
          open
            ? "bg-background/85 py-1 -mx-1 px-1 rounded"
            : "bg-card border border-border/50 rounded-xl px-3.5 py-3"
        )}
      >
        <p className={cn(
          "font-medium text-muted-foreground uppercase tracking-wider",
          open ? "text-[11px]" : "text-[12px] text-foreground normal-case tracking-normal font-semibold"
        )}>{title}</p>
        {!isSearching && (
          <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform duration-200", open ? "rotate-180" : "")} />
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
};

const Settings = () => {
  const {
    theme, setTheme, colorMode,
    themeMode, setThemeMode, scheduleDarkStart, scheduleDarkEnd, setScheduleTimes,
    chatWallpaper, setChatWallpaper, appIcon, setAppIcon, appName, setAppName, appSettings, updateSetting,
  } = useTheme();
  const wallpapersByCategory = useMemo(() => {
    const groups = new Map<string, typeof WALLPAPERS>();
    for (const w of WALLPAPERS) {
      const list = groups.get(w.category) ?? [];
      list.push(w);
      groups.set(w.category, list);
    }
    return [...groups.entries()];
  }, []);
  const navigate  = useNavigate();
  const location  = useLocation();
  const { user }  = useAuth();
  const { toast } = useToast();
  const [showWallpaperPicker, setShowWallpaperPicker] = useState(false);
  const [showPinDialog, setShowPinDialog]         = useState(false);
  const [pinInput, setPinInput]                   = useState("");
  const [pinStep, setPinStep]                     = useState<"verify"|"enter"|"confirm">("enter");
  const [pinFirst, setPinFirst]                   = useState("");
  const [pinVerifyError, setPinVerifyError]       = useState(false);
  const [pinVerifyAttempts, setPinVerifyAttempts] = useState(0);
  const [appNameInput, setAppNameInput]           = useState(appName);
  const appIconInputRef = useRef<HTMLInputElement>(null);
  const [showPartnerDialog, setShowPartnerDialog] = useState(false);
  const [showInviteDialog, setShowInviteDialog]   = useState(false);
  const [showPeekConfig, setShowPeekConfig]       = useState(false);
  const [showMoodHistory, setShowMoodHistory]     = useState(false);
  const [showDeviceQr, setShowDeviceQr]           = useState(false);
  const [devicesQrPanel, setDevicesQrPanel]        = useState<"scan" | "show">("show");
  const [showInviteQr, setShowInviteQr]           = useState(false);
  const [showPartnerScanner, setShowPartnerScanner] = useState(false);

  const [showPasskeyDialog, setShowPasskeyDialog] = useState(false);
  const [showAddEmailPw, setShowAddEmailPw]       = useState(false);
  const [inviteCode, setInviteCode]               = useState("");
  const [joinCode, setJoinCode]                   = useState("");
  const [currentPartner, setCurrentPartner]       = useState<string|null>(null);
  const [partnerName, setPartnerName]             = useState("");
  const [partnerInitials, setPartnerInitials]     = useState("?");
  const [partnerAvatar, setPartnerAvatar]         = useState<string|null>(null);
  const [petName, setPetName]                     = useState("");
  const [editingPetName, setEditingPetName]       = useState(false);
  const [showSearchPartner, setShowSearchPartner] = useState(false);
  const [searchTerm, setSearchTerm]               = useState("");
  const [searchResults, setSearchResults]         = useState<any[]>([]);
  const [searching, setSearching]                 = useState(false);
  // FIX: filter pending requests by current user
  const [pendingRequests, setPendingRequests]     = useState<any[]>([]);
  const [myUsername, setMyUsername]               = useState("");
  const [importingWhatsApp, setImportingWhatsApp] = useState(false);
  const [importProgress, setImportProgress]       = useState("");
  const whatsappFileRef = useRef<HTMLInputElement>(null);
  // WA-08 FIX: WhatsApp exports only give a raw contact name (often just a
  // phone number for whichever side wasn't saved). Ask the user which of
  // the distinct names in the file is them, so imported messages can be
  // labeled "You" / the partner's name instead of the raw export string.
  const [waSenderPick, setWaSenderPick] = useState<{
    senders: string[];
    parsed: { sender: string; content: string; timestamp: Date }[];
  } | null>(null);
  const [searchQuery, setSearchQuery]             = useState("");
  const [showThemeStudio, setShowThemeStudio]     = useState(false);
  const [showIconStudio, setShowIconStudio]       = useState(false);

  // Filter sections by search query (matches against section data-keywords).
  const matches = (keywords: string) => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    return keywords.toLowerCase().includes(q);
  };

  // Collapsible sections: which section ids are collapsed, persisted so the
  // layout the user leaves the page with is the one they come back to.
  // Default: everything collapsed except Account — a page that opens with
  // 8 sections already expanded reads as one long unbroken scroll; opening
  // to just the section headers (each one tap away) is what actually makes
  // "grouped sections" feel grouped instead of just labeled.
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>(() =>
    storage.getJSON<Record<string, boolean>>("duo-settings-collapsed", {
      partner: true, devices: true, security: true, appearance: true,
      anniversary: true, data: true, whatsapp: true,
    })
  );
  const isSearching = searchQuery.trim().length > 0;
  const toggleSection = (id: string) => {
    hapticLight();
    setCollapsedSections(prev => {
      const next = { ...prev, [id]: !prev[id] };
      storage.setJSON("duo-settings-collapsed", next);
      return next;
    });
  };
  const allExpanded = SETTINGS_SECTION_IDS.every(id => !collapsedSections[id]);
  const toggleAllSections = () => {
    hapticLight();
    const next = SETTINGS_SECTION_IDS.reduce((acc, id) => {
      acc[id] = allExpanded; // if currently all expanded, collapse every one
      return acc;
    }, {} as Record<string, boolean>);
    setCollapsedSections(next);
    storage.setJSON("duo-settings-collapsed", next);
  };

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      const { data } = await supabase.from("profiles")
        .select("partner_id,display_name,gender,phone_number,pet_name,username,avatar_url")
        .eq("user_id",user.id).single();
      if (data?.username) setMyUsername(data.username);
      // FIX BUG-10: pet_name is stored on OWN profile (the nickname I give my partner)
      if (data?.pet_name) setPetName(data.pet_name);
      if (data?.partner_id) {
        setCurrentPartner(data.partner_id);
        const { data: pp } = await supabase.from("profiles")
          .select("display_name,avatar_url").eq("user_id",data.partner_id).single();
        if (pp) {
          setPartnerName(pp.display_name||"Partner");
          // FIX: use real initials
          setPartnerInitials((pp.display_name||"P").slice(0,2).toUpperCase());
          setPartnerAvatar(pp.avatar_url||null);
        }
      }
    };
    load();

    const loadRequests = async () => {
      // FIX (was selecting columns that don't exist on partner_requests —
      // e.g. user_id/partner_id/avatar_url/mood_emoji — which made PostgREST
      // reject the query and silently left pendingRequests empty forever, so
      // requests never showed up for the receiver). This table only has
      // id, sender_id, receiver_id, status, created_at, updated_at.
      const { data: reqs, error: reqsErr } = await supabase.from("partner_requests" as any)
        .select("id,sender_id,receiver_id,status,created_at,updated_at")
        .eq("status","pending")
        .eq("receiver_id", user.id);
      if (reqsErr) { setPendingRequests([]); return; }
      if (!reqs?.length) { setPendingRequests([]); return; }
      // Join sender display info so we can show a name instead of a raw id.
      const senderIds = (reqs as any[]).map(r => r.sender_id);
      const { data: senderProfiles } = await supabase.from("profiles")
        .select("user_id,display_name,username,avatar_url")
        .in("user_id", senderIds);
      const byId = new Map((senderProfiles||[]).map((p: any) => [p.user_id, p]));
      setPendingRequests((reqs as any[]).map(r => ({ ...r, sender: byId.get(r.sender_id) })));
    };
    loadRequests();

    const ch = supabase.channel("partner-requests-rt")
      .on("postgres_changes",{ event:"*",schema:"public",table:"partner_requests" },() => loadRequests())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [user]);

  const searchPartners = async () => {
    if (!searchTerm.trim()) return;
    setSearching(true);
    const { data } = await supabase.rpc("search_users",{ search_term:searchTerm.trim() }) as any;
    setSearchResults(data||[]);
    setSearching(false);
    if (!data?.length) toast({ title:"No users found" });
  };

  const sendPartnerRequest = async (receiverId: string) => {
    if (!user) return;
    hapticMedium();
    const { error } = await supabase.from("partner_requests" as any).insert({ sender_id:user.id, receiver_id:receiverId });
    if (error?.code==="23505") toast({ title:"Request already sent", variant:"destructive" });
    else if (error) toast({ title:"Failed", description:error.message, variant:"destructive" });
    else { toast({ title:"Request sent! 💌" }); setSearchResults([]); setSearchTerm(""); }
  };

  // FIX BUG-09: The fallback path ran 4 sequential queries with no transaction.
  // Between query 3 and 4, a concurrent accept could corrupt both users' partner_id.
  // We now wrap the fallback in a single RPC that executes atomically server-side.
  // If that RPC also doesn't exist, we at least add optimistic conflict detection.
  const acceptRequest = async (req: { id: string; requester_id: string; sender_id?: string; requester_name?: string }) => {
    if (!user) return;
    hapticMedium();
    const { error } = await supabase.rpc("accept_partner_request" as any, {
      p_request_id: req.id, p_user_id: user.id,
    });
    if (error) {
      // Fallback: try the v2 atomic RPC first, then a guarded manual path
      const { error: rpc2Err } = await supabase.rpc("accept_partner_request_v2" as any, {
        request_id: req.id, accepting_user_id: user.id,
      });
      if (rpc2Err) {
        // Last-resort manual path — guard with a status check to reduce race window
        const { data: currentReq } = await supabase
          .from("partner_requests" as any)
          .select("status")
          .eq("id", req.id)
          .single();
        if (!currentReq || (currentReq as any).status !== "pending") {
          toast({ title: "Request already handled", variant: "destructive" });
          return;
        }
        // Mark accepted first (unique constraint prevents double-accept)
        const { error: updateErr } = await supabase
          .from("partner_requests" as any)
          .update({ status: "accepted" })
          .eq("id", req.id)
          .eq("status", "pending"); // optimistic lock: only update if still pending
        if (updateErr) {
          toast({ title: "Failed to accept request", description: updateErr.message, variant: "destructive" });
          return;
        }
        await supabase.rpc("unlink_partner", { p_user_id: user.id });
        const senderId = req.sender_id || req.requester_id;
        await supabase.from("profiles").update({ partner_id: senderId }).eq("user_id", user.id);
        await supabase.from("profiles").update({ partner_id: user.id }).eq("user_id", senderId);
      }
    }
    const senderId = req.sender_id || req.requester_id;
    setCurrentPartner(senderId);
    const { data:pp } = await supabase.from("profiles").select("display_name,avatar_url").eq("user_id",senderId).single();
    if (pp) { setPartnerName(pp.display_name||"Partner"); setPartnerInitials((pp.display_name||"P").slice(0,2).toUpperCase()); setPartnerAvatar(pp.avatar_url||null); }
    toast({ title:"Connected! 🎉", description:`Linked with ${pp?.display_name||"your partner"}` });
  };

  const declineRequest = async (id: string) => {
    hapticLight();
    await supabase.from("partner_requests" as any).delete().eq("id",id);
    toast({ title:"Request declined" });
  };

  const saveUsername = async () => {
    if (!user||!myUsername.trim()) return;
    const clean = myUsername.trim().toLowerCase().replace(/[^a-z0-9_.]/g,"");
    if (clean.length < 3) { toast({ title:"Username too short (min 3 chars)", variant:"destructive" }); return; }
    hapticLight();
    const { error } = await supabase.from("profiles").update({ username:clean }).eq("user_id",user.id);
    if (error?.code==="23505") toast({ title:"Username taken", variant:"destructive" });
    else if (error) toast({ title:"Error", description:error.message, variant:"destructive" });
    else { setMyUsername(clean); toast({ title:"Username saved" }); }
  };

  useEffect(() => {
    const urlInvite = new URLSearchParams(location.search).get("invite");
    const pendingInvite = urlInvite || sessionStorage.getItem("duo-pending-invite");
    if (!user||currentPartner||!pendingInvite) return;
    setJoinCode(pendingInvite.toUpperCase());
    setShowPartnerDialog(true);
  }, [currentPartner,location.search,user]);

  const generateInviteLink = async () => {
    if (!user) return;
    hapticMedium();
    // FIX BUG-11: Retry up to 5 times on unique constraint collision (error code 23505).
    // Previously any error (including collision) showed "Failed to create invite" with no retry,
    // leaving the user stuck. Collision is rare but becomes more likely as the code space fills.
    const MAX_ATTEMPTS = 5;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const code = Math.random().toString(36).substring(2, 10).toUpperCase();
      const { error } = await supabase.from("invite_links" as any).insert({ code, creator_id: user.id });
      if (!error) { setInviteCode(code); setShowInviteDialog(true); return; }
      lastError = error;
      if (error.code !== "23505") break; // non-collision error — don't retry
    }
    toast({ title: "Failed to create invite", description: lastError?.message, variant: "destructive" });
  };

  const copyInviteCode  = () => { hapticLight(); navigator.clipboard.writeText(inviteCode); toast({ title:"Code copied" }); };
  const copyInviteLink  = () => { hapticLight(); navigator.clipboard.writeText(`${window.location.origin}/auth?invite=${inviteCode}`); toast({ title:"Link copied" }); };
  const shareInviteLink = async () => {
    const link = `${window.location.origin}/auth?invite=${inviteCode}`;
    if (navigator.share) await navigator.share({ title:"Join me on DuoSpace", text:"Connect with me on DuoSpace", url:link });
    else copyInviteLink();
  };

  const acceptInvite = async () => {
    if (!user||!joinCode.trim()) return;
    hapticMedium();
    const { data, error } = await supabase.rpc("accept_invite",{ p_code:joinCode.trim().toUpperCase(), p_user_id:user.id }) as any;
    if (error||data?.error) {
      const msg = data?.error||error?.message||"Something went wrong";
      if (msg.includes("not found")||msg.includes("already used")) toast({ title:"Invalid or expired code", description:"Ask your partner for a fresh invite code.", variant:"destructive" });
      else if (msg.includes("own invite")) toast({ title:"Can't use your own invite", variant:"destructive" });
      else toast({ title:"Failed to connect", description:msg, variant:"destructive" });
      return;
    }
    setCurrentPartner(data.creator_id);
    setPartnerName(data.creator_name||"your partner");
    setPartnerInitials((data.creator_name||"P").slice(0,2).toUpperCase());
    sessionStorage.removeItem("duo-pending-invite");
    setShowPartnerDialog(false); setJoinCode("");
    if (location.search) navigate("/settings",{ replace:true });
    toast({ title:"Connected! 🎉", description:`Linked with ${data.creator_name||"your partner"}` });
  };

  const unlinkPartner = async () => {
    if (!user||!currentPartner) return;
    hapticMedium();
    const { error } = await supabase.rpc("unlink_partner",{ p_user_id:user.id }) as any;
    if (error) { toast({ title:"Failed to unlink", description:error.message, variant:"destructive" }); return; }
    setCurrentPartner(null); setPartnerName(""); setPartnerInitials("?"); setPartnerAvatar(null);
    toast({ title:"Unlinked" });
  };

  const savePetName = async () => {
    if (!user||!currentPartner) return;
    hapticLight();
    // FIX BUG-10: pet_name is the nickname THIS user calls their partner — it belongs
    // on the current user's own profile row, not the partner's. Writing to the partner's
    // row required UPDATE RLS on a row you don't own, and both users could overwrite
    // each other's pet_name with no conflict resolution.
    // Save to own profile. Load (below) also reads from own profile.
    await supabase.from("profiles").update({ pet_name: petName.trim()||null }).eq("user_id", user.id);
    setEditingPetName(false); toast({ title:"Saved" });
  };

  // FIX: PIN change now requires re-entering the *current* PIN first.
  // Previously "Change PIN" jumped straight to "Enter new PIN" with zero
  // proof of who was holding the phone — anyone with a few seconds of
  // unsupervised access to an unlocked app could silently swap the PIN out
  // from under the real owner. First-time setup (no PIN yet) is unaffected.
  const handlePinDigit = async (d: string) => {
    if (pinStep === "verify" && pinVerifyAttempts >= 5) return;
    if (d==="⌫") { setPinInput(p=>p.slice(0,-1)); return; }
    const next = pinInput + d;
    if (next.length>6) return;
    setPinInput(next);
    if (next.length===6) {
      if (pinStep==="verify") {
        const stored = storage.get("duo-lock-pin");
        const ok = stored ? await verifyPin(next, stored) : true;
        if (ok) {
          setPinVerifyError(false); setPinVerifyAttempts(0);
          setPinInput(""); setPinStep("enter");
        } else {
          const attempts = pinVerifyAttempts + 1;
          setPinVerifyAttempts(attempts);
          setPinVerifyError(true);
          setTimeout(() => { setPinInput(""); setPinVerifyError(false); }, 500);
          if (attempts >= 5) toast({ title: "Too many attempts", description: "Close and try again later.", variant: "destructive" });
        }
        return;
      }
      if (pinStep==="enter") {
        setPinFirst(next); setPinInput(""); setPinStep("confirm");
      } else {
        if (next===pinFirst) {
          const hashed = await hashPin(next);
          storage.set("duo-lock-pin", hashed);
          setShowPinDialog(false); hapticLight();
          toast({ title:"PIN saved ✓" });
        } else {
          setPinInput(""); setPinStep("enter"); setPinFirst("");
          toast({ title:"PINs didn't match, try again", variant:"destructive" });
        }
      }
    }
  };

  // WA-08 FIX: shared batch-insert used both for the no-ambiguity path and
  // after the user picks which sender name is them from waSenderPick.
  const runWhatsAppImport = async (
    parsed: { sender: string; content: string; timestamp: Date }[],
    selfSender: string | null,
  ) => {
    if (!user) return;
    setImportingWhatsApp(true);
    setImportProgress(`Importing ${parsed.length} messages…`);
    const BATCH = 100;
    let inserted = 0;
    let failed = 0;
    for (let i = 0; i < parsed.length; i += BATCH) {
      const batch = parsed.slice(i, i + BATCH).map(msg => ({
        owner_id: user.id,
        sender_name: msg.sender,
        content: msg.content,
        original_timestamp: msg.timestamp.toISOString(),
        is_self: selfSender !== null && msg.sender === selfSender,
      }));
      const { error: batchErr } = await supabase.from("imported_chats" as any).insert(batch);
      if (batchErr) {
        failed += batch.length;
        if (import.meta.env.DEV) { console.error(`[WA Import] Batch ${i}–${i + BATCH} failed:`, batchErr.message); }
      } else {
        inserted += batch.length;
      }
      setImportProgress(`Importing… ${Math.min(i + BATCH, parsed.length)}/${parsed.length}`);
    }

    if (failed > 0 && inserted === 0) {
      toast({ title: "Import failed", description: `All ${failed} messages failed to save. Check your connection.`, variant: "destructive" });
    } else if (failed > 0) {
      toast({ title: `Partially imported`, description: `${inserted} saved, ${failed} failed. Try again to retry missing batches.`, variant: "default" });
    } else {
      toast({ title: `Imported ${inserted} messages 📱`, description: "Scroll up in chat to see them." });
    }
    setImportingWhatsApp(false); setImportProgress("");
  };

  const [hapticIntensity, setHapticIntensityState] = useState<HapticIntensity>(() => getHapticIntensity());
  const chooseHapticIntensity = (level: HapticIntensity) => {
    setHapticIntensity(level);
    setHapticIntensityState(level);
    hapticSelection(); // preview the newly chosen intensity immediately
  };

  const settingsItems = [
    { key:"biometricLock" as const, icon:Fingerprint, label:"App Lock",      desc:"Face ID / Fingerprint + PIN fallback" },
    { key:"notifications" as const, icon:Bell,        label:"Notifications",  desc:"Message & call alerts" },
    { key:"hapticFeedback" as const, icon:Vibrate,    label:"Haptics",        desc:"Vibrate on interactions" },
    { key:"privacyMode" as const, icon:EyeOff,        label:"Privacy",        desc:"Blur in task switcher" },
    { key:"peekGuard" as const, icon:Scan,            label:"Peek Guard",     desc:"Lock when stranger looks at screen" },
    { key:"moodDetection" as const, icon:Smile,       label:"Daily Mood",     desc:"Camera checks your mood once a day" },
  ];

  return (
    <motion.div
      initial={{ opacity:0 }}
      animate={{ opacity:1 }}
      transition={{ duration: 0.15 }}
      className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-24 bg-background"
      style={{ WebkitOverflowScrolling: "touch" as any }}
    >
      <header className="safe-top px-5 pt-4 pb-3 sticky top-0 z-20 bg-background/85 backdrop-blur-xl border-b border-border/40">
        <div className="flex items-center gap-3 mb-3">
          <button onClick={() => { hapticLight(); navigate(-1); }} className="h-10 w-10 rounded-full bg-accent/15 flex items-center justify-center active:scale-95 transition-transform" aria-label="Back">
            <ChevronLeft className="h-5 w-5 text-accent" />
          </button>
          <h1 className="text-lg font-semibold tracking-tight flex-1">Settings</h1>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search settings"
              className="h-9 pl-8 rounded-full bg-muted/60 border-transparent text-sm"
              aria-label="Search settings"
            />
          </div>
          {!isSearching && (
            <button
              onClick={toggleAllSections}
              aria-label={allExpanded ? "Collapse all sections" : "Expand all sections"}
              title={allExpanded ? "Collapse all" : "Expand all"}
              className="h-9 w-9 shrink-0 rounded-full bg-muted/60 flex items-center justify-center active:scale-95 transition-transform"
            >
              {allExpanded ? <ChevronsDownUp className="h-4 w-4 text-muted-foreground" /> : <ChevronsUpDown className="h-4 w-4 text-muted-foreground" />}
            </button>
          )}
        </div>
      </header>

      <div className="px-5 space-y-6 pt-5">

        {/* Account */}
        <SectionShell id="account" title="Account" keywords="account sign out logout email username profile handle"
          matches={matches} isOpen={!collapsedSections.account} isSearching={isSearching} onToggle={toggleSection}>
          <p className="text-xs text-muted-foreground mb-2">{user?.email}</p>
          <div className="bg-card rounded-2xl border border-border/60 p-4 space-y-2 mb-2">
            <p className="text-[11px] font-medium text-muted-foreground">Username</p>
            <div className="flex gap-2">
              <Input value={myUsername} onChange={e=>setMyUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_.]/g,""))}
                placeholder="username" className="h-9 rounded-xl flex-1 text-sm" />
              <Button onClick={saveUsername} size="sm" className="rounded-xl bg-primary text-primary-foreground h-9 px-4 text-xs">Save</Button>
            </div>
            <p className="text-[10px] text-muted-foreground">Letters, numbers, . and _ only. Min 3 characters.</p>
          </div>
          <button onClick={async () => { hapticMedium(); await supabase.auth.signOut(); }}
            className="w-full bg-card rounded-xl border border-border/60 p-3 text-sm text-destructive text-center active:scale-[0.98] transition-transform">
            Sign Out
          </button>
        </SectionShell>

        {/* Partner */}
        <SectionShell id="partner" title="Partner" keywords="partner invite link username code request connect unlink"
          matches={matches} isOpen={!collapsedSections.partner} isSearching={isSearching} onToggle={toggleSection}>

          {/* Pending partner requests */}
          {pendingRequests.length > 0 && (
            <div className="mb-3 space-y-2">
              {pendingRequests.map(req => (
                <div key={req.id} className="bg-card rounded-2xl border border-primary/20 p-4 flex items-center gap-3">
                  <div className="h-9 w-9 rounded-full bg-primary/20 flex items-center justify-center text-sm font-semibold text-primary">💌</div>
                  <div className="flex-1"><p className="text-sm font-medium">Partner request</p><p className="text-[11px] text-muted-foreground">from {req.sender?.display_name || (req.sender?.username && `@${req.sender.username}`) || `${req.sender_id?.slice(0,8)}…`}</p></div>
                  <button onClick={() => acceptRequest(req)} className="h-7 px-3 rounded-full bg-primary text-primary-foreground text-[11px]">Accept</button>
                  <button onClick={() => declineRequest(req.id)} className="h-7 px-3 rounded-full bg-muted text-muted-foreground text-[11px]">Decline</button>
                </div>
              ))}
            </div>
          )}

          {currentPartner ? (
            <div className="space-y-2">
              <div className="bg-card rounded-2xl border border-border/60 p-4 flex items-center gap-3">
                {/* FIX: real avatar or real initials */}
                <div className="h-10 w-10 rounded-full bg-accent/50 flex items-center justify-center text-sm font-semibold text-foreground overflow-hidden">
                  {partnerAvatar
                    ? <img src={partnerAvatar} alt={partnerName} className="h-full w-full object-cover" />
                    : partnerInitials}
                </div>
                <div className="flex-1"><p className="text-sm font-medium">{partnerName}</p><p className="text-[11px] text-muted-foreground">Connected</p></div>
                <button onClick={unlinkPartner} className="h-7 px-3 rounded-full bg-muted text-[11px] flex items-center gap-1 text-muted-foreground active:scale-95 transition-transform">
                  <Unlink className="h-3 w-3" /> Unlink
                </button>
              </div>
              <div className="bg-card rounded-2xl border border-border/60 p-4">
                <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-2">Pet name for partner</p>
                {editingPetName ? (
                  <div className="flex gap-2">
                    <Input value={petName} onChange={e=>setPetName(e.target.value)} placeholder="Baby, Love, Jaan..." className="h-8 rounded-full text-sm flex-1" autoFocus />
                    <Button onClick={savePetName} size="sm" className="rounded-full bg-primary text-primary-foreground h-8 px-4 text-xs">Save</Button>
                  </div>
                ) : (
                  <button onClick={() => setEditingPetName(true)} className="flex items-center gap-2 text-sm text-foreground">
                    {petName||<span className="text-muted-foreground">Add a pet name…</span>}
                    <Pencil className="h-3 w-3 text-muted-foreground" />
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <button onClick={() => { hapticLight(); setShowPartnerScanner(true); }}
                className="w-full bg-card rounded-2xl border border-border/60 p-4 flex items-center gap-3 active:scale-[0.98] transition-transform">
                <Scan className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 text-left"><p className="text-sm font-medium">Scan partner's QR</p><p className="text-[11px] text-muted-foreground">Open camera and scan their code</p></div>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </button>

              <button onClick={() => setShowSearchPartner(true)}
                className="w-full bg-card rounded-2xl border border-border/60 p-4 flex items-center gap-3 active:scale-[0.98] transition-transform">
                <Search className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 text-left"><p className="text-sm font-medium">Find by username</p><p className="text-[11px] text-muted-foreground">Search for your partner by username</p></div>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </button>
            </div>
          )}

        </SectionShell>

        {/* Devices — QR sign-in on another device + QR-based signup invite */}
        {user && (
          <SectionShell id="devices" title="Devices & Sign-in" keywords="device qr scan sign in on another new account invite signup pair pairing recent history session where signed"
            matches={matches} isOpen={!collapsedSections.devices} isSearching={isSearching} onToggle={toggleSection}>
            <div className="space-y-2">
              <button onClick={() => { hapticLight(); setDevicesQrPanel("show"); setShowDeviceQr(true); }}
                className="w-full bg-card rounded-2xl border border-border/60 p-4 flex items-center gap-3 active:scale-[0.98] transition-transform">
                <QrCode className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 text-left">
                  <p className="text-sm font-medium">QR code</p>
                  <p className="text-[11px] text-muted-foreground">Show yours to sign in elsewhere, or scan one to sign in, link, or invite</p>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </button>
              <button onClick={() => { hapticLight(); setShowInviteQr(true); }}
                className="w-full bg-card rounded-2xl border border-border/60 p-4 flex items-center gap-3 active:scale-[0.98] transition-transform">
                <UserPlus className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 text-left">
                  <p className="text-sm font-medium">Invite a new user via QR</p>
                  <p className="text-[11px] text-muted-foreground">Scanning routes them straight to the Sign Up screen</p>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </button>
              <button onClick={() => { hapticLight(); setShowPasskeyDialog(true); }}
                className="w-full bg-card rounded-2xl border border-border/60 p-4 flex items-center gap-3 active:scale-[0.98] transition-transform">
                <Fingerprint className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 text-left">
                  <p className="text-sm font-medium">Add a passkey</p>
                  <p className="text-[11px] text-muted-foreground">Use Face ID / Touch ID / Windows Hello to sign in</p>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </button>
              {(!user.email || user.app_metadata?.provider === "qr") && (
                <button onClick={() => { hapticLight(); setShowAddEmailPw(true); }}
                  className="w-full bg-card rounded-2xl border border-border/60 p-4 flex items-center gap-3 active:scale-[0.98] transition-transform">
                  <KeyRound className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="flex-1 text-left">
                    <p className="text-sm font-medium">Add email + password</p>
                    <p className="text-[11px] text-muted-foreground">Verified via a 6-digit code — needed if you signed up via QR</p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </button>
              )}
            </div>
            <p className="text-[11px] font-medium text-muted-foreground mt-4 mb-2">Recent devices</p>
            <RecentDevices />
          </SectionShell>
        )}

        {/* Security & Privacy */}
        <SectionShell id="security" title="Security & Privacy" keywords="security privacy lock pin biometric fingerprint face haptic notification mood"
          matches={matches} isOpen={!collapsedSections.security} isSearching={isSearching} onToggle={toggleSection}>
          <div className="bg-card rounded-2xl border border-border/60 divide-y divide-border/40">
            {settingsItems.map(item => (
              <div key={item.key} className="flex items-center gap-3 px-4 py-3">
                <item.icon className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{item.label}</p>
                  <p className="text-[11px] text-muted-foreground">{item.desc}</p>
                </div>
                <Switch checked={appSettings[item.key]||false} onCheckedChange={v => {
                  hapticLight(); updateSetting(item.key,v);
                  if (item.key==="biometricLock" && v && !storage.get("duo-lock-pin")) {
                    setPinInput(""); setPinStep("enter"); setPinFirst("");
                    setPinVerifyError(false); setPinVerifyAttempts(0);
                    setShowPinDialog(true);
                  }
                  // Fix #Bug11: sync to the localStorage key MoodDetector checks on startup
                  if (item.key==="moodDetection") storage.set("mood-detection-enabled", v ? "true" : "false");
                }} />
              </div>
            ))}
            {appSettings.hapticFeedback && (
              <div className="flex items-center gap-3 px-4 py-3">
                <div className="h-4 w-4 shrink-0" aria-hidden="true" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">Haptic intensity</p>
                  <p className="text-[11px] text-muted-foreground">How strong feedback feels</p>
                </div>
                <div className="flex items-center gap-1 rounded-full bg-muted p-1" role="radiogroup" aria-label="Haptic intensity">
                  {(["subtle", "standard", "strong"] as HapticIntensity[]).map(level => (
                    <button
                      key={level}
                      role="radio"
                      aria-checked={hapticIntensity === level}
                      onClick={() => chooseHapticIntensity(level)}
                      className={`px-2.5 py-1 rounded-full text-[11px] capitalize transition-colors ${
                        hapticIntensity === level ? "bg-accent text-accent-foreground" : "text-muted-foreground"
                      }`}
                    >
                      {level}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="flex items-center gap-3 px-4 py-3">
              <KeyRound className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0"><p className="text-sm font-medium">Change PIN</p><p className="text-[11px] text-muted-foreground">Update your 6-digit lock PIN</p></div>
              <button onClick={() => {
                setPinInput("");
                setPinStep(storage.get("duo-lock-pin") ? "verify" : "enter");
                setPinFirst("");
                setPinVerifyError(false); setPinVerifyAttempts(0);
                setShowPinDialog(true);
              }}
                className="h-7 px-3 rounded-full bg-muted text-[11px] text-foreground">Change</button>
            </div>
            {appSettings.peekGuard && (
              <div className="flex items-center gap-3 px-4 py-3">
                <Scan className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0"><p className="text-sm font-medium">Peek Guard setup</p><p className="text-[11px] text-muted-foreground">Enroll face, sensitivity & triggers</p></div>
                <button onClick={() => { hapticLight(); setShowPeekConfig(true); }}
                  className="h-7 px-3 rounded-full bg-muted text-[11px] text-foreground">Configure</button>
              </div>
            )}
            {appSettings.moodDetection && (
              <div className="flex items-center gap-3 px-4 py-3">
                <Smile className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0"><p className="text-sm font-medium">Mood history</p><p className="text-[11px] text-muted-foreground">Trends from your daily check-ins</p></div>
                <button onClick={() => { hapticLight(); setShowMoodHistory(true); }}
                  className="h-7 px-3 rounded-full bg-muted text-[11px] text-foreground">View</button>
              </div>
            )}
          </div>
        </SectionShell>

        {/* Appearance */}
        <SectionShell id="appearance" title="Appearance" keywords="appearance theme color wallpaper icon name dark light auto schedule time adaptive dynamic sky"
          matches={matches} isOpen={!collapsedSections.appearance} isSearching={isSearching} onToggle={toggleSection}>
          <div className="space-y-2">
            {/* App name */}
            <div className="bg-card rounded-2xl border border-border/60 p-4 space-y-2">
              <p className="text-[11px] text-muted-foreground uppercase tracking-wider">App Name</p>
              <div className="flex gap-2">
                <Input
                  value={appNameInput}
                  onChange={e => setAppNameInput(e.target.value)}
                  placeholder="DuoSpace"
                  maxLength={32}
                  className="h-9 rounded-xl flex-1 text-sm"
                />
                <Button
                  onClick={() => {
                    // NAME-02 FIX: Validate before saving. Match the rule described
                    // in the UI: letters, numbers, . and _ only, 3–32 chars.
                    const val = appNameInput.trim();
                    if (!/^[a-zA-Z0-9._]{3,32}$/.test(val)) {
                      toast({ title: "Invalid name", description: "Letters, numbers, . and _ only. Min 3 characters.", variant: "destructive" });
                      return;
                    }
                    setAppName(val);
                    toast({ title: "Name updated", description: "Changes the in-app display name only." });
                  }}
                  size="sm"
                  className="rounded-xl bg-primary text-primary-foreground h-9 px-4 text-xs"
                >Save</Button>
              </div>
              <p className="text-[10px] text-muted-foreground">Letters, numbers, . and _ only · 3–32 chars · In-app display only</p>
            </div>
            {/* App icon */}
            <div className="bg-card rounded-2xl border border-border/60 p-4 flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-muted flex items-center justify-center overflow-hidden">
                {appIcon ? <img src={appIcon} alt="" className="h-full w-full object-cover" /> : <Image className="h-5 w-5 text-muted-foreground" />}
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium">App Icon</p>
                {/* ICON-01 + NAME-01 FIX: Be honest about scope. Native home screen icon
                    cannot be changed at runtime — it is baked into the app binary. Quick
                    upload here only affects the in-app display (lock screen, chat header,
                    browser tab). Icon Studio below additionally lets you design a proper
                    icon and export the real Android/iOS native asset set for the build. */}
                <p className="text-[11px] text-muted-foreground">Changes in-app display & browser tab · Home screen icon unchanged</p>
              </div>
              <div className="flex items-center gap-2">
                {appIcon && <button onClick={() => setAppIcon(null)} className="text-[10px] text-destructive">Remove</button>}
                <button onClick={() => appIconInputRef.current?.click()} aria-label="Upload custom app icon" className="h-7 px-3 rounded-full bg-muted text-[11px] text-foreground"><Upload className="h-3 w-3" aria-hidden="true" /></button>
              </div>
            </div>
            <input ref={appIconInputRef} type="file" accept="image/*" className="hidden" onChange={async e => {
              const file = e.target.files?.[0]; if (!file) return;
              const reader = new FileReader();
              reader.onload = () => setAppIcon(reader.result as string);
              reader.readAsDataURL(file); e.target.value="";
            }} />
            <button
              onClick={() => { hapticLight(); setShowIconStudio(true); }}
              className="w-full h-9 rounded-xl bg-gradient-to-r from-primary/15 to-accent/30 border border-border/60 text-xs font-medium flex items-center justify-center gap-1.5 active:scale-[0.98] transition-transform"
            >
              <Wand2 className="h-3.5 w-3.5" /> Open Icon Studio — presets, custom, export Android/iOS
            </button>
            {/* Theme */}
            <div className="bg-card rounded-2xl border border-border/60 p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-[11px] text-muted-foreground uppercase tracking-wider">Appearance mode</p>
                <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                  {colorMode === "dark" ? <Moon className="h-3 w-3" /> : <Sun className="h-3 w-3" />}
                  {colorMode === "dark" ? "Dark now" : "Light now"}
                </span>
              </div>
              <div className="grid grid-cols-5 gap-1.5 mb-3">
                {([
                  { id: "light" as const, label: "Light", icon: Sun },
                  { id: "dark" as const, label: "Dark", icon: Moon },
                  { id: "auto" as const, label: "Auto", icon: MonitorSmartphone },
                  { id: "schedule" as const, label: "Timed", icon: Clock },
                  { id: "dynamic" as const, label: "Dynamic", icon: Sparkles },
                ]).map(opt => (
                  <button
                    key={opt.id}
                    onClick={() => { hapticLight(); setThemeMode(opt.id); }}
                    aria-pressed={themeMode === opt.id}
                    className={cn(
                      "h-14 rounded-xl border flex flex-col items-center justify-center gap-1 text-[9.5px] font-medium transition-all",
                      themeMode === opt.id
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border/60 bg-muted/30 text-muted-foreground"
                    )}
                  >
                    <opt.icon className="h-3.5 w-3.5" />
                    {opt.label}
                  </button>
                ))}
              </div>
              {themeMode === "auto" && (
                <p className="text-[10px] text-muted-foreground mb-3">Follows your device's system light/dark setting automatically.</p>
              )}
              {themeMode === "schedule" && (
                <div className="mb-3 space-y-2">
                  <p className="text-[10px] text-muted-foreground">Switches to dark mode in the evening and back to light in the morning.</p>
                  <div className="flex items-center gap-2">
                    <div className="flex-1">
                      <label className="text-[10px] text-muted-foreground mb-1 block">Dark from</label>
                      <input
                        type="time"
                        value={scheduleDarkStart}
                        onChange={e => { hapticLight(); setScheduleTimes(e.target.value, scheduleDarkEnd); }}
                        className="w-full h-9 rounded-xl border border-border/60 bg-muted/30 px-3 text-sm"
                      />
                    </div>
                    <div className="flex-1">
                      <label className="text-[10px] text-muted-foreground mb-1 block">Light from</label>
                      <input
                        type="time"
                        value={scheduleDarkEnd}
                        onChange={e => { hapticLight(); setScheduleTimes(scheduleDarkStart, e.target.value); }}
                        className="w-full h-9 rounded-xl border border-border/60 bg-muted/30 px-3 text-sm"
                      />
                    </div>
                  </div>
                </div>
              )}
              {themeMode === "dynamic" && (
                <p className="text-[10px] text-muted-foreground mb-3">
                  Theme colors — and the Dynamic Sky wallpaper below — continuously shift through the day like Apple's dynamic wallpapers, with no hard switch at any point.
                </p>
              )}
              <div className="grid grid-cols-4 gap-2">
                {THEMES.map((t) => (
                  <button key={t.id} onClick={() => { setTheme(t.id); hapticLight(); }}
                    aria-label={`${t.name} theme${theme===t.id ? " (selected)" : ""}`}
                    aria-pressed={theme===t.id}
                    className={cn("h-12 rounded-xl border-2 transition-all", theme===t.id?"border-primary":"border-transparent")}
                    style={{ background:t.preview }}>
                    {theme===t.id && <Check className="h-4 w-4 text-foreground mx-auto" aria-hidden="true" />}
                  </button>
                ))}
              </div>
              <button
                onClick={() => { hapticLight(); setShowThemeStudio(true); }}
                className="mt-3 w-full h-9 rounded-xl bg-gradient-to-r from-primary/15 to-accent/30 border border-border/60 text-xs font-medium flex items-center justify-center gap-1.5 active:scale-[0.98] transition-transform"
              >
                <Palette className="h-3.5 w-3.5" /> Open Theme Studio
              </button>
            </div>
            {/* Wallpaper */}
            <div className="bg-card rounded-2xl border border-border/60 p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-[11px] text-muted-foreground uppercase tracking-wider">Chat Wallpaper</p>
                {chatWallpaper && <button onClick={() => setChatWallpaper(null)} className="text-[10px] text-destructive">Remove</button>}
              </div>
              <div className="space-y-4">
                {wallpapersByCategory.map(([category, list]) => (
                  <div key={category}>
                    <p className="text-[10px] text-muted-foreground mb-1.5">{category}</p>
                    <div data-swipe-nav-ignore className="flex gap-2 overflow-x-auto pb-1">
                      {list.map(w => {
                        // Dynamic Sky's swatch is computed live from the current
                        // time (see dynamicSky.ts) instead of the static
                        // light/dark pair every other wallpaper uses.
                        const preview = w.live ? resolveWallpaperStyle(w.id, colorMode) : (colorMode === "dark" ? w.dark : w.light);
                        const active = chatWallpaper === w.id;
                        return (
                          <button key={w.id} onClick={() => { setChatWallpaper(w.id); hapticLight(); }}
                            title={w.live ? `${w.name} — shifts with the time of day` : w.name}
                            aria-label={`${w.name} wallpaper${active ? " (selected)" : ""}`}
                            aria-pressed={active}
                            className={cn("h-16 w-16 rounded-2xl shrink-0 border-2 transition-all relative overflow-hidden",
                              active ? "border-primary" : "border-transparent")}
                            style={{ background: preview }}>
                            {w.live && (
                              <span className="absolute top-1 left-1 h-3.5 w-3.5 rounded-full bg-black/30 flex items-center justify-center">
                                <span className="h-1.5 w-1.5 rounded-full bg-white animate-pulse" />
                              </span>
                            )}
                            {active && (
                              <span className="absolute inset-0 flex items-center justify-center bg-black/10">
                                <Check className="h-4 w-4 text-white drop-shadow" aria-hidden="true" />
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
              {chatWallpaper === "w-dynamic-sky" && (
                <p className="text-[10px] text-muted-foreground mt-3">
                  Dynamic Sky shifts continuously through night, dawn, day and dusk colors as the real time changes — like Apple's dynamic wallpapers.
                </p>
              )}
            </div>
          </div>
        </SectionShell>


        {/* Anniversary */}
        <SectionShell id="anniversary" title="Anniversary" keywords="anniversary date love"
          matches={matches} isOpen={!collapsedSections.anniversary} isSearching={isSearching} onToggle={toggleSection}>
          <div className="bg-card rounded-2xl border border-border/60 p-4 space-y-2">
            <p className="text-sm font-medium">Your special date 💕</p>
            <input type="date" value={appSettings.anniversaryDate||""}
              onChange={e => { hapticLight(); updateSetting("anniversaryDate",e.target.value||null); if(e.target.value) toast({ title:"Anniversary saved 💕" }); }}
              className="w-full h-9 rounded-xl border border-border/60 bg-muted/30 px-3 text-sm" />
            {appSettings.anniversaryDate && (
              <button onClick={() => { hapticLight(); updateSetting("anniversaryDate",null); }} className="text-[11px] text-destructive">Remove</button>
            )}
          </div>
        </SectionShell>

        {/* Data & Backup — includes Cloud Sync status plus the BackupManager
            and DailyKeyManager sub-components, grouped so they collapse
            together instead of adding three separate scroll stops. */}
        <SectionShell id="data" title="Data & Backup" keywords="data backup cloud sync recovery restore key daily"
          matches={matches} isOpen={!collapsedSections.data} isSearching={isSearching} onToggle={toggleSection}>
          <div className="bg-card rounded-2xl border border-border/60 divide-y divide-border/40 mb-2">
            <div className="flex items-center gap-3 px-4 py-3">
              <Download className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0"><p className="text-sm font-medium">Cloud Sync</p><p className="text-[11px] text-muted-foreground">All data auto-syncs. Just log in to restore.</p></div>
              <div className="h-2 w-2 rounded-full bg-primary" />
            </div>
            <div className="flex items-center gap-3 px-4 py-3">
              <RotateCcw className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0"><p className="text-sm font-medium">Chat Recovery</p><p className="text-[11px] text-muted-foreground">Deleted chats can be recovered from the chat menu.</p></div>
            </div>
          </div>

          {/* Cloud Backup — replaces the old per-user Google Drive flow, which
              was still being rendered alongside this (duplicate "connect
              backup" UI) until now. */}
          <BackupManager />

          {/* Daily.co per-user key */}
          <DailyKeyManager />
        </SectionShell>

        {/* WhatsApp Import */}
        <SectionShell id="whatsapp" title="Import" keywords="whatsapp import chat history"
          matches={matches} isOpen={!collapsedSections.whatsapp} isSearching={isSearching} onToggle={toggleSection}>
          <div className="bg-card rounded-2xl border border-border/60">
            <button onClick={() => whatsappFileRef.current?.click()} disabled={importingWhatsApp}
              className="w-full flex items-center gap-3 px-4 py-3 text-left active:scale-[0.98] transition-transform disabled:opacity-50">
              <MessageSquare className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{importingWhatsApp ? (importProgress||"Importing...") : "Import WhatsApp Chat"}</p>
                <p className="text-[11px] text-muted-foreground">Upload exported .txt or .zip · appears in chat timeline</p>
              </div>
              <Upload className="h-4 w-4 text-muted-foreground" />
            </button>
          </div>
          <input ref={whatsappFileRef} type="file" accept=".txt,.zip" className="hidden"
            onChange={async e => {
              const file = e.target.files?.[0];
              if (!file || !user) return;
              setImportingWhatsApp(true); setImportProgress("Reading file…");
              try {
                // ── Read file ────────────────────────────────────────────────
                let text = "";
                if (file.name.endsWith(".txt")) {
                  text = await file.text();
                } else if (file.name.endsWith(".zip")) {
                  try {
                    const JSZip = (await import("jszip")).default;
                    const zip = await JSZip.loadAsync(file);
                    const txtFile = Object.keys(zip.files).find(f => f.endsWith(".txt"));
                    if (txtFile) text = await zip.files[txtFile].async("text");
                    else throw new Error("No .txt file found inside ZIP");
                  } catch (zipErr: any) {
                    toast({ title: "ZIP import failed", description: zipErr?.message || String(zipErr), variant: "destructive" });
                    setImportingWhatsApp(false); e.target.value = ""; return;
                  }
                }
                if (!text.trim()) {
                  toast({ title: "Could not read file", variant: "destructive" });
                  setImportingWhatsApp(false); return;
                }

                // ── Parse ────────────────────────────────────────────────────
                setImportProgress("Parsing messages…");
                const lines = text.split("\n");

                // WA-02 FIX: Strip Unicode directional marks (U+200E LRM, U+200F RLM,
                // U+FEFF BOM) that WhatsApp iOS prepends to every line. These invisible
                // characters sit before the ^ anchor and break regex matching entirely,
                // causing 0 matches on all iOS exports.
                const stripMarks = (s: string) => s.replace(/^[\u200e\u200f\ufeff]+/, "");

                // WA-04 FIX: Extended regex that also matches ISO-style YYYY-MM-DD prefix
                // (some locales export as "2023-12-25, 15:45 - Sender: msg").
                // Original only matched \d{1,2} leading group, missing 4-digit year prefix.
                const re = /^\[?(\d{1,4}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[APap][Mm])?)\]?\s*[-–]?\s*([^:]+):\s*(.*)/;

                // WA-06 FIX: Known junk content patterns to skip. WhatsApp system lines
                // often have a sender-like colon pattern but are not real messages.
                const JUNK_CONTENT = [
                  /^<Media omitted>$/i,
                  /^image omitted$/i,
                  /^video omitted$/i,
                  /^sticker omitted$/i,
                  /^audio omitted$/i,
                  /^document omitted$/i,
                  /^GIF omitted$/i,
                  /^null$/i,
                  /^This message was deleted$/i,
                  /^You deleted this message\.?$/i,
                  /^Messages and calls are end.to.end encrypted/i,
                  /^Your messages.*security code/i,
                  /^\s*$/,
                ];
                const isJunk = (content: string) => JUNK_CONTENT.some(p => p.test(content.trim()));

                // BUG FIX: the previous version decided DD/MM vs MM/DD per line
                // ("leading number > 12 → day-first, otherwise assume month-first").
                // A single WhatsApp export uses ONE consistent format throughout, but
                // that per-line guess silently swapped day/month on any line where the
                // leading number was ambiguous (1-12) — about 40% of all dates in a
                // typical month — scrambling chronological order within the imported
                // chat and, combined with real-time messages, elsewhere in the timeline.
                // Now: scan every date in the file ONCE first. If any date's first
                // number is >12, the whole file MUST be DD/MM (that's the only reading
                // that makes every date valid). If any date's second number is >12, the
                // whole file MUST be MM/DD. Apply that single determination to every
                // line. Only falls back to a per-file default (day-first — the more
                // common WhatsApp export format outside the US) if the file is fully
                // ambiguous (every date has both components ≤12).
                let dayFirst: boolean | null = null;
                {
                  const dateRe = /^\[?(\d{1,4}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/;
                  for (const rawLine of lines) {
                    const dm = stripMarks(rawLine).match(dateRe);
                    if (!dm) continue;
                    const dp = dm[1].replace(/[\-\.]/g, "/");
                    const p = dp.split("/");
                    if (p.length !== 3 || p[0].length === 4) continue; // YYYY-MM-DD is unambiguous, skip
                    const first = parseInt(p[0], 10);
                    const second = parseInt(p[1], 10);
                    if (first > 12) { dayFirst = true; break; }
                    if (second > 12) { dayFirst = false; break; }
                  }
                  if (dayFirst === null) dayFirst = true; // ambiguous file-wide → default to day-first
                }

                // WA-03 FIX: Robust timestamp parser that handles:
                //   - 12h with uppercase AM/PM  ✅ (JS native)
                //   - 12h with lowercase am/pm  ❌ JS rejects → manual normalise
                //   - 24h (no AM/PM)            ✅ (JS native with ISO string)
                //   - 2-digit years             ✅ handled by explicit parse
                const parseTimestamp = (datePart: string, timePart: string): Date | null => {
                  // Normalise separators to /
                  const dp = datePart.replace(/[\-\.]/g, "/");
                  const parts = dp.split("/");
                  if (parts.length !== 3) return null;

                  let [a, b, c] = parts;
                  // WA-07 FIX: Disambiguate DD/MM vs MM/DD using the file-wide format
                  // determined above, so every line in a single export is parsed the
                  // same way. Expand 2-digit year → 4-digit (00–29 → 2000–2029, 30–99 → 1930–1999).
                  let month: string, day: string, year: string;
                  if (a.length === 4) {          // YYYY-MM-DD
                    [year, month, day] = [a, b, c];
                  } else if (dayFirst) {         // DD/MM/YYYY or DD/MM/YY
                    [day, month, year] = [a, b, c];
                  } else {                        // MM/DD/YYYY or MM/DD/YY
                    [month, day, year] = [a, b, c];
                  }
                  if (year.length === 2) year = (parseInt(year) <= 29 ? "20" : "19") + year;

                  // WA-03 FIX: Normalise am/pm to uppercase so JS Date() accepts it
                  const tp = timePart.trim().replace(/\s*(am|pm)$/i, m => " " + m.trim().toUpperCase());
                  const is12h = /[AP]M$/i.test(tp);

                  let ts: Date;
                  if (is12h) {
                    // "3:45:22 PM" or "3:45 PM"
                    ts = new Date(`${month}/${day}/${year} ${tp}`);
                  } else {
                    // 24h — build ISO-ish string that JS reliably parses
                    const [hh, mm, ss = "00"] = tp.split(":");
                    ts = new Date(`${year}-${month.padStart(2,"0")}-${day.padStart(2,"0")}T${hh.padStart(2,"0")}:${mm}:${ss}`);
                  }
                  return isNaN(ts.getTime()) ? null : ts;
                };

                const parsed: { sender: string; content: string; timestamp: Date }[] = [];
                for (const rawLine of lines) {
                  const line = stripMarks(rawLine); // WA-02
                  const m = line.match(re);
                  if (m) {
                    const [, datePart, timePart, sender, content] = m;
                    const ts = parseTimestamp(datePart, timePart); // WA-03, WA-04, WA-07
                    const trimmedContent = content.trim();
                    if (!ts) continue;                      // skip unparseable timestamps
                    if (isJunk(trimmedContent)) continue;   // WA-06: skip <Media omitted> etc
                    parsed.push({ sender: sender.trim(), content: trimmedContent, timestamp: ts });
                  } else if (parsed.length > 0 && line.trim()) {
                    // Continuation line (multi-line message)
                    parsed[parsed.length - 1].content += "\n" + line.trim();
                  }
                }

                if (!parsed.length) {
                  toast({ title: "No messages found", description: "Check the file format — try exporting without media.", variant: "destructive" });
                  setImportingWhatsApp(false); e.target.value = ""; return;
                }

                // WA-08 FIX: figure out who's who before inserting. If there are
                // 2+ distinct sender names, ask the user which one is them so we
                // can tag each row (is_self) instead of showing the raw export
                // name forever. With only one distinct name there's nothing to
                // disambiguate, so skip straight to import.
                const distinctSenders = Array.from(new Set(parsed.map(p => p.sender)));
                if (distinctSenders.length > 1) {
                  setWaSenderPick({ senders: distinctSenders, parsed });
                  setImportingWhatsApp(false);
                  e.target.value = "";
                  return;
                }
                await runWhatsAppImport(parsed, null);
              } catch (err: unknown) {
                toast({ title: "Import failed", description: (err instanceof Error ? err.message : String(err)), variant: "destructive" });
                setImportingWhatsApp(false); setImportProgress("");
              }
              e.target.value = "";
            }} />
          {/* WA-08 FIX: let the user say which raw export name is them, so
              imported messages show "You" / the partner's name instead of
              whatever WhatsApp had saved (often just a phone number). */}
          <Dialog open={!!waSenderPick} onOpenChange={(open) => { if (!open) setWaSenderPick(null); }}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Which one is you?</DialogTitle>
                <DialogDescription>
                  This chat has messages from {waSenderPick?.senders.length} names. Pick the one that's you
                  so we can label the chat correctly for both of you.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-2 py-2">
                {waSenderPick?.senders.map((name) => (
                  <button
                    key={name}
                    onClick={() => {
                      const pick = waSenderPick;
                      setWaSenderPick(null);
                      if (pick) runWhatsAppImport(pick.parsed, name);
                    }}
                    className="w-full text-left px-4 py-3 rounded-xl bg-muted/50 border border-border/60 active:scale-[0.98] transition-transform"
                  >
                    <p className="text-sm font-medium truncate">{name}</p>
                  </button>
                ))}
              </div>
              <DialogFooter>
                <Button variant="ghost" onClick={() => {
                  const pick = waSenderPick;
                  setWaSenderPick(null);
                  // Skip disambiguation — import without tagging anyone as "you".
                  if (pick) runWhatsAppImport(pick.parsed, null);
                }}>
                  Skip / not sure
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </SectionShell>

        <CodeSurpriseEditor partnerId={currentPartner} />
      </div>

      {/* PIN Setup Dialog */}
      <Dialog open={showPinDialog} onOpenChange={v => { if(!v){setPinInput("");setPinStep("enter");setPinFirst("");setPinVerifyError(false);setPinVerifyAttempts(0);} setShowPinDialog(v); }}>
        <DialogContent className="rounded-2xl max-w-[320px]">
          <DialogHeader>
            <DialogTitle className="text-base">
              {pinStep==="verify" ? "Enter current PIN" : pinStep==="enter" ? "Enter new PIN" : "Confirm PIN"}
            </DialogTitle>
            <DialogDescription>
              {pinStep==="verify" ? "Confirm it's you before changing your PIN" : pinStep==="enter" ? "Choose a 6-digit PIN" : "Enter the same PIN again"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className={`flex gap-2 justify-center ${pinVerifyError ? "animate-[shake_0.3s]" : ""}`}>
              {Array.from({ length:6 }).map((_,i) => (
                <div key={i} className={`h-4 w-4 rounded-full border-2 transition-all ${
                  pinVerifyError ? "bg-destructive border-destructive" :
                  pinInput.length>i?"bg-primary border-primary":"border-border"
                }`} />
              ))}
            </div>
            {pinStep==="verify" && pinVerifyError && (
              <p className="text-center text-[11px] text-destructive">Wrong PIN — {5 - pinVerifyAttempts} attempt{5 - pinVerifyAttempts===1?"":"s"} left</p>
            )}
            <div className="grid grid-cols-3 gap-3">
              {["1","2","3","4","5","6","7","8","9","","0","⌫"].map((d,i) => (
                <button key={i} onClick={() => handlePinDigit(d)}
                  disabled={pinStep==="verify" && pinVerifyAttempts>=5}
                  className={`h-14 rounded-xl flex items-center justify-center text-lg font-medium transition-all active:scale-90 disabled:opacity-40 ${d?"bg-card border border-border text-foreground":"invisible"}`}>
                  {d}
                </button>
              ))}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Partner-QR scanner dialog: reuses the sign-in scanner. Scanning a
          partner's signup_invite QR routes them into signup with pre-linked
          partner intent; scanning an anon_signup QR marks them as pending
          partner for whoever finishes signup on the issuing device. */}
      <Dialog open={showPartnerScanner} onOpenChange={setShowPartnerScanner}>
        <DialogContent className="rounded-2xl max-w-[360px]">
          <DialogHeader>
            <DialogTitle className="text-base">Scan partner's QR</DialogTitle>
            <DialogDescription>Point at the QR on their device to link.</DialogDescription>
          </DialogHeader>
          {showPartnerScanner && (
            <QRSignInScanner
              onClose={() => setShowPartnerScanner(false)}
              onPartnerLinked={() => { setShowPartnerScanner(false); toast({ title: "Linked ✓", description: "Waiting for partner to finish signup." }); }}
              onSignupInvite={() => { setShowPartnerScanner(false); toast({ title: "Linked ✓", description: "Waiting for partner to finish signup." }); }}
            />
          )}
        </DialogContent>
      </Dialog>


      {/* Search partner dialog */}
      <Dialog open={showSearchPartner} onOpenChange={setShowSearchPartner}>
        <DialogContent className="rounded-2xl max-w-[340px]">
          <DialogHeader><DialogTitle className="text-base">Find your partner</DialogTitle><DialogDescription>Search by username or phone</DialogDescription></DialogHeader>
          <div className="flex gap-2">
            <Input value={searchTerm} onChange={e=>setSearchTerm(e.target.value)} placeholder="Username or +1234567890" className="rounded-xl flex-1" onKeyDown={e=>e.key==="Enter"&&searchPartners()} />
            <Button onClick={searchPartners} disabled={searching} size="sm" className="rounded-xl bg-primary text-primary-foreground"><Search className="h-4 w-4" /></Button>
          </div>
          {searchResults.length>0 && (
            <div className="space-y-2 mt-2">
              {searchResults.map((r:any) => (
                <div key={r.user_id} className="flex items-center gap-3 bg-muted/40 rounded-xl p-3">
                  {r.avatar_url ? <img src={r.avatar_url} className="h-8 w-8 rounded-full object-cover" />
                    : <div className="h-8 w-8 rounded-full bg-accent flex items-center justify-center text-xs font-semibold text-accent-foreground">{(r.display_name||"?").charAt(0).toUpperCase()}</div>}
                  <div className="flex-1 min-w-0"><p className="text-sm font-medium truncate">{r.display_name}</p>{r.username&&<p className="text-[10px] text-muted-foreground">@{r.username}</p>}</div>
                  <Button onClick={()=>sendPartnerRequest(r.user_id)} size="sm" className="rounded-full h-9 px-3 text-[10px] bg-primary text-primary-foreground"><UserPlus className="h-3 w-3 mr-1" /> Request</Button>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ThemeStudio open={showThemeStudio} onOpenChange={setShowThemeStudio} />
      <IconStudio open={showIconStudio} onOpenChange={setShowIconStudio} appName={appName} onApply={setAppIcon} />
      <PeekConfigDialog open={showPeekConfig} onClose={() => setShowPeekConfig(false)} />
      <MoodHistory open={showMoodHistory} onClose={() => setShowMoodHistory(false)} />

      <Dialog open={showDeviceQr} onOpenChange={setShowDeviceQr}>
        <DialogContent className="rounded-2xl max-w-[360px]">
          <DialogHeader>
            <DialogTitle className="text-base">QR code</DialogTitle>
            <DialogDescription>Show your code, or scan one from another device.</DialogDescription>
          </DialogHeader>
          {showDeviceQr && (
            <Tabs value={devicesQrPanel} onValueChange={(v) => setDevicesQrPanel(v as "scan" | "show")} className="w-full">
              <TabsList className="grid w-full grid-cols-2 rounded-xl bg-muted/50">
                <TabsTrigger value="scan" className="rounded-lg text-xs">Scan a QR</TabsTrigger>
                <TabsTrigger value="show" className="rounded-lg text-xs">Show my QR</TabsTrigger>
              </TabsList>
              <TabsContent value="scan" className="mt-4">
                <QRSignInScanner
                  onClose={() => setShowDeviceQr(false)}
                  onSuccess={() => setShowDeviceQr(false)}
                  onPartnerLinked={() => setShowDeviceQr(false)}
                  onSignupInvite={() => { setShowDeviceQr(false); toast({ title: "That QR is for someone else's signup", description: "Have them scan it from the Auth screen instead." }); }}
                />
              </TabsContent>
              <TabsContent value="show" className="mt-4">
                <p className="text-xs text-muted-foreground text-center mb-3 px-2">Open the Auth screen on your other device, tap "Sign in with QR", and scan this code.</p>
                <QRSignInDisplay mode="device_pairing" onClose={() => setShowDeviceQr(false)} />
              </TabsContent>
            </Tabs>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={showInviteQr} onOpenChange={setShowInviteQr}>
        <DialogContent className="rounded-2xl max-w-[360px]">
          <DialogHeader>
            <DialogTitle className="text-base">Invite a new user</DialogTitle>
            <DialogDescription>They open the Auth screen, tap “Sign in with QR”, scan this — they’ll land on the Sign Up form.</DialogDescription>
          </DialogHeader>
          {showInviteQr && <QRSignInDisplay mode="signup_invite" onClose={() => setShowInviteQr(false)} />}
        </DialogContent>
      </Dialog>

      <Dialog open={showPasskeyDialog} onOpenChange={setShowPasskeyDialog}>
        <DialogContent className="rounded-2xl max-w-[360px]">
          <DialogHeader>
            <DialogTitle className="text-base">Add a passkey</DialogTitle>
            <DialogDescription>Use your device's biometrics to sign in without a password.</DialogDescription>
          </DialogHeader>
          {showPasskeyDialog && (
            <PasskeyRegister onDone={() => setShowPasskeyDialog(false)} />
          )}
        </DialogContent>
      </Dialog>

      <AddEmailPasswordDialog
        open={showAddEmailPw}
        onOpenChange={setShowAddEmailPw}
      />
    </motion.div>
  );
};

export default Settings;

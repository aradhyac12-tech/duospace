import { motion } from "framer-motion";
import { useTheme, ThemeColor, THEMES } from "@/contexts/ThemeContext";
import {
  ChevronLeft, Check, ImageIcon, X, Bell, Fingerprint, Vibrate, Link2, Unlink,
  EyeOff, Copy, Share2, Eye, ChevronRight, Palette, Download, RotateCcw,
  MessageSquare, Upload, Scan, KeyRound, Smartphone, Image,
  Pencil, Search, UserPlus, Smile, QrCode,
} from "lucide-react";
import CodeSurpriseEditor from "@/components/CodeSurpriseEditor";
import { useLocation, useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import { useState, useEffect, useMemo, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Slider } from "@/components/ui/slider";
import { hapticLight, hapticMedium } from "@/lib/haptics";
import storage from "@/lib/storage";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { hashPin } from "@/lib/crypto";
import BackupManager from "@/components/BackupManager";
import DailyKeyManager from "@/components/DailyKeyManager";
import RecentDevices from "@/components/RecentDevices";
import GoogleDriveBackup from "@/components/GoogleDriveBackup";
import ThemeStudio from "@/components/ThemeStudio";
import PeekConfigDialog from "@/components/PeekConfigDialog";
import QRSignInDisplay from "@/components/auth/QRSignInDisplay";
import QRSignInScanner from "@/components/auth/QRSignInScanner";
import PasskeyRegister from "@/components/auth/PasskeyRegister";
import AddEmailPasswordDialog from "@/components/auth/AddEmailPasswordDialog";


const presetWallpapers = [
  { id: "w-minimal-light", name: "Minimal Light", category: "Minimal", style: `linear-gradient(180deg, hsl(30,15%,97%) 0%, hsl(30,10%,94%) 100%), url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20width%3D%22180%22%20height%3D%22180%22%3E%3Cfilter%20id%3D%22n%22%3E%3CfeTurbulence%20type%3D%22fractalNoise%22%20baseFrequency%3D%220.9%22%20numOctaves%3D%222%22%20stitchTiles%3D%22stitch%22/%3E%3CfeColorMatrix%20type%3D%22saturate%22%20values%3D%220%22/%3E%3C/filter%3E%3Crect%20width%3D%22100%25%22%20height%3D%22100%25%22%20filter%3D%22url%28%2523n%29%22%20opacity%3D%220.05%22/%3E%3C/svg%3E")` },
  { id: "w-minimal-dark", name: "Minimal Dark", category: "Minimal", style: `linear-gradient(180deg, hsl(230,15%,10%) 0%, hsl(230,12%,7%) 100%), url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20width%3D%22180%22%20height%3D%22180%22%3E%3Cfilter%20id%3D%22n%22%3E%3CfeTurbulence%20type%3D%22fractalNoise%22%20baseFrequency%3D%220.9%22%20numOctaves%3D%222%22%20stitchTiles%3D%22stitch%22/%3E%3CfeColorMatrix%20type%3D%22saturate%22%20values%3D%220%22/%3E%3C/filter%3E%3Crect%20width%3D%22100%25%22%20height%3D%22100%25%22%20filter%3D%22url%28%2523n%29%22%20opacity%3D%220.08%22/%3E%3C/svg%3E")` },
  { id: "w-sunset", name: "Sunset", category: "Soft Gradient", style: `linear-gradient(135deg, hsl(20,70%,90%) 0%, hsl(345,55%,85%) 100%)` },
  { id: "w-horizon", name: "Horizon", category: "Soft Gradient", style: `linear-gradient(135deg, hsl(200,55%,88%) 0%, hsl(230,45%,80%) 100%)` },
  { id: "w-mesh-light", name: "Mesh Bloom", category: "Mesh Gradient", style: `radial-gradient(at 15% 20%, hsl(340,70%,88%) 0%, transparent 55%), radial-gradient(at 85% 10%, hsl(220,65%,86%) 0%, transparent 55%), radial-gradient(at 50% 100%, hsl(160,55%,86%) 0%, transparent 55%), hsl(30,20%,97%)` },
  { id: "w-mesh-dark", name: "Mesh Glow", category: "Mesh Gradient", style: `radial-gradient(at 20% 15%, hsl(265,60%,25%) 0%, transparent 55%), radial-gradient(at 85% 20%, hsl(200,55%,22%) 0%, transparent 55%), radial-gradient(at 50% 100%, hsl(320,50%,20%) 0%, transparent 55%), hsl(230,20%,8%)` },
  { id: "w-aurora", name: "Aurora", category: "Aurora", style: `radial-gradient(at 10% 0%, hsl(160,80%,35%) 0%, transparent 45%), radial-gradient(at 90% 10%, hsl(260,80%,40%) 0%, transparent 45%), radial-gradient(at 50% 90%, hsl(200,80%,35%) 0%, transparent 50%), hsl(230,25%,6%)` },
  { id: "w-grain-warm", name: "Warm Grain", category: "Noise", style: `linear-gradient(160deg, hsl(28,30%,92%) 0%, hsl(24,25%,86%) 100%), url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20width%3D%22180%22%20height%3D%22180%22%3E%3Cfilter%20id%3D%22n%22%3E%3CfeTurbulence%20type%3D%22fractalNoise%22%20baseFrequency%3D%220.9%22%20numOctaves%3D%222%22%20stitchTiles%3D%22stitch%22/%3E%3CfeColorMatrix%20type%3D%22saturate%22%20values%3D%220%22/%3E%3C/filter%3E%3Crect%20width%3D%22100%25%22%20height%3D%22100%25%22%20filter%3D%22url%28%2523n%29%22%20opacity%3D%220.05%22/%3E%3C/svg%3E")` },
  { id: "w-grain-dark", name: "Charcoal Grain", category: "Noise", style: `linear-gradient(160deg, hsl(0,0%,11%) 0%, hsl(0,0%,7%) 100%), url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20width%3D%22180%22%20height%3D%22180%22%3E%3Cfilter%20id%3D%22n%22%3E%3CfeTurbulence%20type%3D%22fractalNoise%22%20baseFrequency%3D%220.9%22%20numOctaves%3D%222%22%20stitchTiles%3D%22stitch%22/%3E%3CfeColorMatrix%20type%3D%22saturate%22%20values%3D%220%22/%3E%3C/filter%3E%3Crect%20width%3D%22100%25%22%20height%3D%22100%25%22%20filter%3D%22url%28%2523n%29%22%20opacity%3D%220.08%22/%3E%3C/svg%3E")` },
  { id: "w-paper", name: "Paper", category: "Paper", style: `linear-gradient(175deg, hsl(38,35%,95%) 0%, hsl(35,28%,90%) 100%), url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20width%3D%22180%22%20height%3D%22180%22%3E%3Cfilter%20id%3D%22n%22%3E%3CfeTurbulence%20type%3D%22fractalNoise%22%20baseFrequency%3D%220.75%22%20numOctaves%3D%223%22%20stitchTiles%3D%22stitch%22/%3E%3CfeColorMatrix%20type%3D%22saturate%22%20values%3D%220%22/%3E%3C/filter%3E%3Crect%20width%3D%22100%25%22%20height%3D%22100%25%22%20filter%3D%22url%28%2523n%29%22%20opacity%3D%220.045%22/%3E%3C/svg%3E")` },
  { id: "w-dots-light", name: "Dot Grid Light", category: "Minimal Shapes", style: `radial-gradient(circle, hsl(30,10%,75%) 1px, transparent 1.2px) 0 0/16px 16px, hsl(30,15%,97%)` },
  { id: "w-dots-dark", name: "Dot Grid Dark", category: "Minimal Shapes", style: `radial-gradient(circle, hsl(220,10%,30%) 1px, transparent 1.2px) 0 0/16px 16px, hsl(230,15%,9%)` },
  { id: "w-forest", name: "Forest Mist", category: "Nature", style: `linear-gradient(160deg, hsl(150,25%,90%) 0%, hsl(155,20%,78%) 100%)` },
  { id: "w-ocean", name: "Ocean Depth", category: "Nature", style: `linear-gradient(160deg, hsl(195,45%,20%) 0%, hsl(210,50%,10%) 100%)` },
];

const Settings = () => {
  const { theme, setTheme, colorMode, toggleColorMode, chatWallpaper, setChatWallpaper, appIcon, setAppIcon, appName, setAppName, appSettings, updateSetting } = useTheme();
  const wallpapersByCategory = useMemo(() => {
    const groups = new Map<string, typeof presetWallpapers>();
    for (const w of presetWallpapers) {
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
  const [pinStep, setPinStep]                     = useState<"enter"|"confirm">("enter");
  const [pinFirst, setPinFirst]                   = useState("");
  const [appNameInput, setAppNameInput]           = useState(appName);
  const appIconInputRef = useRef<HTMLInputElement>(null);
  const [showPartnerDialog, setShowPartnerDialog] = useState(false);
  const [showInviteDialog, setShowInviteDialog]   = useState(false);
  const [showPeekConfig, setShowPeekConfig]       = useState(false);
  const [showDeviceQr, setShowDeviceQr]           = useState(false);
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
  const [searchQuery, setSearchQuery]             = useState("");
  const [showThemeStudio, setShowThemeStudio]     = useState(false);

  // Filter sections by search query (matches against section data-keywords).
  const matches = (keywords: string) => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    return keywords.toLowerCase().includes(q);
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
      // FIX: filter to current user as receiver only
      const { data: reqs } = await supabase.from("partner_requests" as any)
        .select("id,user_id,avatar_url,display_name,username,partner_id,pet_name,gender,phone_number,public_key,push_token,push_platform,mood_emoji,mood_text,mood_updated_at,location_mode,gallery_shared,created_at,updated_at")
        .eq("status","pending")
        .eq("receiver_id", user.id);
      if (reqs) setPendingRequests(reqs);
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

  // FIX: PIN setup uses PBKDF2 hashing
  const handlePinDigit = async (d: string) => {
    if (d==="⌫") { setPinInput(p=>p.slice(0,-1)); return; }
    const next = pinInput + d;
    if (next.length>6) return;
    setPinInput(next);
    if (next.length===6) {
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
          <button onClick={() => { hapticLight(); navigate(-1); }} className="h-8 w-8 rounded-full bg-accent/60 flex items-center justify-center active:scale-95 transition-transform" aria-label="Back">
            <ChevronLeft className="h-4 w-4 text-foreground" />
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

      <div className="px-5 space-y-6 pt-5">

        {/* Partner */}
        <section hidden={!matches("partner invite link username code request connect unlink")}>
          <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2.5 sticky top-[112px] z-10 bg-background/85 backdrop-blur-sm py-1 -mx-1 px-1 rounded">Partner</p>

          {/* Pending partner requests */}
          {pendingRequests.length > 0 && (
            <div className="mb-3 space-y-2">
              {pendingRequests.map(req => (
                <div key={req.id} className="bg-card rounded-2xl border border-primary/20 p-4 flex items-center gap-3">
                  <div className="h-9 w-9 rounded-full bg-primary/20 flex items-center justify-center text-sm font-semibold text-primary">💌</div>
                  <div className="flex-1"><p className="text-sm font-medium">Partner request</p><p className="text-[11px] text-muted-foreground">from {req.sender_id?.slice(0,8)}…</p></div>
                  <button onClick={() => acceptRequest(req)} className="h-7 px-3 rounded-full bg-foreground text-background text-[11px]">Accept</button>
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
                    <Button onClick={savePetName} size="sm" className="rounded-full bg-foreground text-background h-8 px-4 text-xs">Save</Button>
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
              <button onClick={() => { hapticLight(); setShowInviteQr(true); }}
                className="w-full bg-card rounded-2xl border border-border/60 p-4 flex items-center gap-3 active:scale-[0.98] transition-transform">
                <QrCode className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 text-left"><p className="text-sm font-medium">Show my QR</p><p className="text-[11px] text-muted-foreground">Your partner scans this to link instantly</p></div>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </button>
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

        </section>

        {/* Devices — QR sign-in on another device + QR-based signup invite */}
        {user && (
          <section hidden={!matches("device qr scan sign in on another new account invite signup pair pairing")}>
            <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2.5 sticky top-[112px] z-10 bg-background/85 backdrop-blur-sm py-1 -mx-1 px-1 rounded">Devices</p>
            <div className="space-y-2">
              <button onClick={() => { hapticLight(); setShowDeviceQr(true); }}
                className="w-full bg-card rounded-2xl border border-border/60 p-4 flex items-center gap-3 active:scale-[0.98] transition-transform">
                <QrCode className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 text-left">
                  <p className="text-sm font-medium">Sign in on another device</p>
                  <p className="text-[11px] text-muted-foreground">Show a QR — scan from the Auth screen on your other device</p>
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
          </section>
        )}

        {/* Username */}
        <section hidden={!matches("username profile handle")}>
          <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2.5 sticky top-[112px] z-10 bg-background/85 backdrop-blur-sm py-1 -mx-1 px-1 rounded">Your Username</p>
          <div className="bg-card rounded-2xl border border-border/60 p-4 space-y-2">
            <div className="flex gap-2">
              <Input value={myUsername} onChange={e=>setMyUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_.]/g,""))}
                placeholder="username" className="h-9 rounded-xl flex-1 text-sm" />
              <Button onClick={saveUsername} size="sm" className="rounded-xl bg-foreground text-background h-9 px-4 text-xs">Save</Button>
            </div>
            <p className="text-[10px] text-muted-foreground">Letters, numbers, . and _ only. Min 3 characters.</p>
          </div>
        </section>

        {/* Appearance */}
        <section hidden={!matches("appearance theme color wallpaper icon name dark light")}>
          <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2.5 sticky top-[112px] z-10 bg-background/85 backdrop-blur-sm py-1 -mx-1 px-1 rounded">Appearance</p>
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
                  className="rounded-xl bg-foreground text-background h-9 px-4 text-xs"
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
                    cannot be changed at runtime — it is baked into the app binary. This
                    only affects the in-app display (lock screen, chat header, browser tab). */}
                <p className="text-[11px] text-muted-foreground">Changes in-app display & browser tab · Home screen icon unchanged</p>
              </div>
              <div className="flex items-center gap-2">
                {appIcon && <button onClick={() => setAppIcon(null)} className="text-[10px] text-destructive">Remove</button>}
                <button onClick={() => appIconInputRef.current?.click()} className="h-7 px-3 rounded-full bg-muted text-[11px] text-foreground"><Upload className="h-3 w-3" /></button>
              </div>
            </div>
            <input ref={appIconInputRef} type="file" accept="image/*" className="hidden" onChange={async e => {
              const file = e.target.files?.[0]; if (!file) return;
              const reader = new FileReader();
              reader.onload = () => setAppIcon(reader.result as string);
              reader.readAsDataURL(file); e.target.value="";
            }} />
            {/* Theme */}
            <div className="bg-card rounded-2xl border border-border/60 p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-[11px] text-muted-foreground uppercase tracking-wider">Theme</p>
                <button
                  onClick={() => { hapticLight(); toggleColorMode(); }}
                  className="h-7 px-3 rounded-full bg-muted text-[11px] font-medium flex items-center gap-1.5"
                >
                  {colorMode === "dark" ? "🌙 Dark" : "☀️ Light"}
                </button>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {THEMES.map((t) => (
                  <button key={t.id} onClick={() => { setTheme(t.id); hapticLight(); }}
                    className={cn("h-12 rounded-xl border-2 transition-all", theme===t.id?"border-foreground":"border-transparent")}
                    style={{ background:t.preview }}>
                    {theme===t.id && <Check className="h-4 w-4 text-foreground mx-auto" />}
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
                    <div className="flex gap-2 overflow-x-auto pb-1">
                      {list.map(w => (
                        <button key={w.id} onClick={() => { setChatWallpaper(w.style); hapticLight(); }}
                          title={w.name}
                          className={cn("h-16 w-16 rounded-2xl shrink-0 border-2 transition-all relative overflow-hidden",
                            chatWallpaper===w.style ? "border-foreground" : "border-transparent")}
                          style={{ background: w.style }}>
                          {chatWallpaper===w.style && (
                            <span className="absolute inset-0 flex items-center justify-center bg-black/10">
                              <Check className="h-4 w-4 text-white drop-shadow" />
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Security */}
        <section hidden={!matches("device sign in recent history session where signed")}>
          <RecentDevices />
        </section>

        <section hidden={!matches("security privacy lock pin biometric fingerprint face haptic notification mood")}>
          <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2.5 sticky top-[112px] z-10 bg-background/85 backdrop-blur-sm py-1 -mx-1 px-1 rounded">Security & Privacy</p>
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
                  if (item.key==="biometricLock" && v && !storage.get("duo-lock-pin")) setShowPinDialog(true);
                  // Fix #Bug11: sync to the localStorage key MoodDetector checks on startup
                  if (item.key==="moodDetection") storage.set("mood-detection-enabled", v ? "true" : "false");
                }} />
              </div>
            ))}
            <div className="flex items-center gap-3 px-4 py-3">
              <KeyRound className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0"><p className="text-sm font-medium">Change PIN</p><p className="text-[11px] text-muted-foreground">Update your 6-digit lock PIN</p></div>
              <button onClick={() => { setPinInput(""); setPinStep("enter"); setPinFirst(""); setShowPinDialog(true); }}
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
          </div>
        </section>

        {/* Anniversary */}
        <section hidden={!matches("anniversary date love")}>
          <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2.5 sticky top-[112px] z-10 bg-background/85 backdrop-blur-sm py-1 -mx-1 px-1 rounded">Anniversary</p>
          <div className="bg-card rounded-2xl border border-border/60 p-4 space-y-2">
            <p className="text-sm font-medium">Your special date 💕</p>
            <input type="date" value={appSettings.anniversaryDate||""}
              onChange={e => { hapticLight(); updateSetting("anniversaryDate",e.target.value||null); if(e.target.value) toast({ title:"Anniversary saved 💕" }); }}
              className="w-full h-9 rounded-xl border border-border/60 bg-muted/30 px-3 text-sm" />
            {appSettings.anniversaryDate && (
              <button onClick={() => { hapticLight(); updateSetting("anniversaryDate",null); }} className="text-[11px] text-destructive">Remove</button>
            )}
          </div>
        </section>

        {/* Data */}
        <section hidden={!matches("data backup cloud sync recovery restore")}>
          <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2.5 sticky top-[112px] z-10 bg-background/85 backdrop-blur-sm py-1 -mx-1 px-1 rounded">Data & Backup</p>
          <div className="bg-card rounded-2xl border border-border/60 divide-y divide-border/40">
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
        </section>

        {/* Cloud Backup */}
        <BackupManager />

        {/* Google Drive per-user backup */}
        <GoogleDriveBackup />

        {/* Daily.co per-user key */}
        <DailyKeyManager />

        {/* WhatsApp Import */}
        <section hidden={!matches("whatsapp import chat history")}>
          <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2.5 sticky top-[112px] z-10 bg-background/85 backdrop-blur-sm py-1 -mx-1 px-1 rounded">Import</p>
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
                  // WA-07 FIX: Disambiguate DD/MM vs MM/DD.
                  // If the leading group is 4-digits → it's YYYY, reorder to MM/DD/YYYY.
                  // If the leading group is >12    → it must be DD, swap to MM/DD/YYYY.
                  // Otherwise treat as MM/DD/YYYY (US format, most common in WhatsApp).
                  // Expand 2-digit year → 4-digit (00–29 → 2000–2029, 30–99 → 1930–1999).
                  let month: string, day: string, year: string;
                  if (a.length === 4) {          // YYYY-MM-DD
                    [year, month, day] = [a, b, c];
                  } else if (parseInt(a) > 12) { // DD/MM/YYYY or DD/MM/YY
                    [day, month, year] = [a, b, c];
                  } else {                        // MM/DD/YYYY or MM/DD/YY (US default)
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

                // ── Insert in batches with per-batch error checking ──────────
                // WA-05 FIX: Check each batch result. Previous code ignored errors,
                // so a mid-import failure silently dropped all remaining batches while
                // showing the full parsed count as successfully imported.
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
                  }));
                  const { error: batchErr } = await supabase.from("imported_chats" as any).insert(batch);
                  if (batchErr) {
                    failed += batch.length;
                    if (import.meta.env.DEV) { console.error(`[WA Import] Batch ${i}–${i + BATCH} failed:`, batchErr.message); } /* AUDIT FIX #16 */
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
              } catch (err: unknown) {
                toast({ title: "Import failed", description: (err instanceof Error ? err.message : String(err)), variant: "destructive" });
              }
              setImportingWhatsApp(false); setImportProgress(""); e.target.value = "";
            }} />
        </section>

        <CodeSurpriseEditor partnerId={currentPartner} />

        {/* Account */}
        <section className="pb-4" hidden={!matches("account sign out logout email")}>
          <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2.5 sticky top-[112px] z-10 bg-background/85 backdrop-blur-sm py-1 -mx-1 px-1 rounded">Account</p>
          <p className="text-xs text-muted-foreground mb-2">{user?.email}</p>
          <button onClick={async () => { hapticMedium(); await supabase.auth.signOut(); }}
            className="w-full bg-card rounded-xl border border-border/60 p-3 text-sm text-destructive text-center active:scale-[0.98] transition-transform">
            Sign Out
          </button>
        </section>
      </div>

      {/* PIN Setup Dialog */}
      <Dialog open={showPinDialog} onOpenChange={v => { if(!v){setPinInput("");setPinStep("enter");setPinFirst("");} setShowPinDialog(v); }}>
        <DialogContent className="rounded-2xl max-w-[320px]">
          <DialogHeader>
            <DialogTitle className="text-base">{pinStep==="enter"?"Enter new PIN":"Confirm PIN"}</DialogTitle>
            <DialogDescription>{pinStep==="enter"?"Choose a 6-digit PIN":"Enter the same PIN again"}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="flex gap-2 justify-center">
              {Array.from({ length:6 }).map((_,i) => (
                <div key={i} className={`h-4 w-4 rounded-full border-2 transition-all ${pinInput.length>i?"bg-foreground border-foreground":"border-border"}`} />
              ))}
            </div>
            <div className="grid grid-cols-3 gap-3">
              {["1","2","3","4","5","6","7","8","9","","0","⌫"].map((d,i) => (
                <button key={i} onClick={() => handlePinDigit(d)}
                  className={`h-14 rounded-xl flex items-center justify-center text-lg font-medium transition-all active:scale-90 ${d?"bg-card border border-border text-foreground":"invisible"}`}>
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
              onSuccess={() => { setShowPartnerScanner(false); toast({ title: "Linked ✓" }); }}
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
            <Button onClick={searchPartners} disabled={searching} size="sm" className="rounded-xl bg-foreground text-background"><Search className="h-4 w-4" /></Button>
          </div>
          {searchResults.length>0 && (
            <div className="space-y-2 mt-2">
              {searchResults.map((r:any) => (
                <div key={r.user_id} className="flex items-center gap-3 bg-muted/40 rounded-xl p-3">
                  {r.avatar_url ? <img src={r.avatar_url} className="h-8 w-8 rounded-full object-cover" />
                    : <div className="h-8 w-8 rounded-full bg-accent flex items-center justify-center text-xs font-semibold">{(r.display_name||"?").charAt(0).toUpperCase()}</div>}
                  <div className="flex-1 min-w-0"><p className="text-sm font-medium truncate">{r.display_name}</p>{r.username&&<p className="text-[10px] text-muted-foreground">@{r.username}</p>}</div>
                  <Button onClick={()=>sendPartnerRequest(r.user_id)} size="sm" className="rounded-full h-7 px-3 text-[10px] bg-foreground text-background"><UserPlus className="h-3 w-3 mr-1" /> Request</Button>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ThemeStudio open={showThemeStudio} onOpenChange={setShowThemeStudio} />
      <PeekConfigDialog open={showPeekConfig} onClose={() => setShowPeekConfig(false)} />

      <Dialog open={showDeviceQr} onOpenChange={setShowDeviceQr}>
        <DialogContent className="rounded-2xl max-w-[360px]">
          <DialogHeader>
            <DialogTitle className="text-base">Sign in on another device</DialogTitle>
            <DialogDescription>Open the Auth screen on your other device, tap “Sign in with QR”, and scan this code.</DialogDescription>
          </DialogHeader>
          {showDeviceQr && <QRSignInDisplay mode="device_pairing" onClose={() => setShowDeviceQr(false)} />}
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

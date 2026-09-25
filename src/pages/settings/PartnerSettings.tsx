import { useState, useEffect, useMemo } from "react";
import { motion } from "framer-motion";
import PageHeader from "@/components/PageHeader";
import {
  Scan, Search, ChevronRight, UserPlus, Unlink, Pencil, Loader2, Copy, Share2, KeyRound, Clock,
} from "lucide-react";
import { useNavigate, useLocation } from "react-router-dom";
import { supabase } from "@/integrations/supabase/appClient";
import { useAuth } from "@/hooks/useAuth";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { hapticMedium } from "@/lib/haptics";
import QRSignInScanner from "@/components/auth/QRSignInScanner";
import ConfirmActionDialog from "@/components/settings/ConfirmActionDialog";
import CodeSurpriseEditor from "@/components/CodeSurpriseEditor";
import { useUnlinkRequests, useFinishUnlink } from "@/hooks/useUnlinkRequests";
import { describeUnlinkError } from "@/lib/partnerUnlink";
import { getCachedPartner } from "@/lib/partnerCache";
import { readSettingsCache, writeSettingsCache } from "@/lib/settingsCache";
import { requireOnline } from "@/lib/offlineGuard";
import { isOnlineNow } from "@/lib/connectivity";

/**
 * SECURITY FIX (invite-code entropy): Math.random() is not
 * cryptographically secure and its output is predictable given enough
 * samples — unsuitable for an 8-character code that, per
 * docs/PHASE_4_SECURITY_AUDIT.md, is the only credential gating
 * accept_invite()'s partner-linking flow. crypto.getRandomValues over a
 * 32-symbol unambiguous alphabet (Crockford-style, no 0/O/1/I/L
 * confusion) gives ~40 bits of entropy per 8-char code — small enough to
 * stay a code someone can read aloud/type, large enough that guessing it
 * isn't practical the way Math.random()'s output could theoretically be
 * predicted.
 */
const INVITE_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // 32 symbols, no 0/O/1/I/L
function generateInviteCode(length = 8): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let code = "";
  for (let i = 0; i < length; i++) code += INVITE_CODE_ALPHABET[bytes[i] % INVITE_CODE_ALPHABET.length];
  return code;
}

/**
 * Partner pairing/linking is its own page: it has network round-trips
 * (search, request, accept), a scanner, and a destructive unlink action —
 * enough moving parts that it deserved a dedicated screen rather than one
 * collapsible section on the Settings hub.
 *
 * Unlinking needs the OTHER partner's approval: "Unlink" only sends a request
 * (see lib/partnerUnlink.ts for the whole flow); the pairing ends when the
 * partner allows it. The approval dialog itself lives in UnlinkRequestHost
 * (app-wide); this screen shows the waiting / incoming state alongside it.
 */
const PartnerSettings = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const { toast } = useToast();

  const [showPartnerScanner, setShowPartnerScanner] = useState(false);
  const [showSearchPartner, setShowSearchPartner] = useState(false);
  const [showPartnerDialog, setShowPartnerDialog] = useState(false);
  const [showInviteDialog, setShowInviteDialog] = useState(false);
  const [showUnlinkConfirm, setShowUnlinkConfirm] = useState(false);

  const [inviteCode, setInviteCode] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [generatingInvite, setGeneratingInvite] = useState(false);
  const [acceptingInvite, setAcceptingInvite] = useState(false);

  // Painted from the last known pairing (the record Chat already keeps —
  // partnerCache.ts — plus the pet name saved by this screen) so the Partner
  // screen is right instantly and offline. Before this, a failed load fell
  // through to the "link a partner" view for someone who IS linked.
  const seedPartner = useMemo(() => (user ? getCachedPartner(user.id) : null), [user]);
  const seedPet = useMemo(() => readSettingsCache<{ petName: string; partnerName: string }>(user?.id, "partner-screen"), [user]);
  const [currentPartner, setCurrentPartner] = useState<string | null>(seedPartner?.partnerId ?? null);
  const [partnerName, setPartnerName] = useState(seedPet?.partnerName || seedPartner?.partnerName || "");
  const [partnerInitials, setPartnerInitials] = useState(((seedPet?.partnerName || seedPartner?.partnerName || "?").slice(0, 2)).toUpperCase());
  const [partnerAvatar, setPartnerAvatar] = useState<string | null>(seedPartner?.partnerAvatar ?? null);
  const [petName, setPetName] = useState(seedPet?.petName ?? "");
  // True when the pairing status could not be loaded AND nothing is remembered.
  const [loadFailed, setLoadFailed] = useState(false);
  const [editingPetName, setEditingPetName] = useState(false);
  const [savingPetName, setSavingPetName] = useState(false);

  const [searchTerm, setSearchTerm] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [pendingRequests, setPendingRequests] = useState<any[]>([]);
  const [requestActionId, setRequestActionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(!seedPartner);
  // Bumped after a QR scan links the two accounts so the screen re-reads the
  // profile and shows the new partner instead of the "not linked" view.
  const [reloadNonce, setReloadNonce] = useState(0);

  // Two-sided unlink: `outgoing` = we asked and are waiting; `incoming` = the
  // partner asked us (also handled by the app-wide dialog — listed here too so
  // it isn't lost if that dialog was put off with "decide later").
  const finishUnlink = useFinishUnlink();
  const {
    incoming: incomingUnlinks, outgoing: outgoingUnlink,
    requestUnlink, respond: respondToUnlink, cancel: cancelUnlink,
  } = useUnlinkRequests({ scope: "partner-settings" });
  const [unlinkBusy, setUnlinkBusy] = useState(false);

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      const { data, error } = await supabase.from("profiles")
        .select("partner_id,pet_name")
        .eq("user_id", user.id).single();
      if (error) {
        // Offline / server hiccup: keep whatever we already show. Only with
        // nothing remembered is it a real "couldn't load" — and that state
        // must never be mistaken for "not linked".
        if (!seedPartner) setLoadFailed(true);
        setLoading(false);
        return;
      }
      setLoadFailed(false);
      setPetName(data?.pet_name ?? "");
      if (data?.partner_id) {
        setCurrentPartner(data.partner_id);
        const { data: pp } = await supabase.from("profiles")
          .select("display_name,avatar_url").eq("user_id", data.partner_id).single();
        if (pp) {
          setPartnerName(pp.display_name || "Partner");
          setPartnerInitials((pp.display_name || "P").slice(0, 2).toUpperCase());
          setPartnerAvatar(pp.avatar_url || null);
          writeSettingsCache(user.id, "partner-screen", { petName: data?.pet_name ?? "", partnerName: pp.display_name || "Partner" });
        }
      } else {
        // Server-confirmed: no partner (e.g. unlinked from the other phone).
        setCurrentPartner(null);
      }
      setLoading(false);
    };
    load();

    const loadRequests = async () => {
      const { data: reqs, error: reqsErr } = await supabase.from("partner_requests" as any)
        .select("id,sender_id,receiver_id,status,created_at,updated_at")
        .eq("status", "pending")
        .eq("receiver_id", user.id);
      if (reqsErr) { setPendingRequests([]); return; }
      if (!reqs?.length) { setPendingRequests([]); return; }
      const senderIds = (reqs as any[]).map(r => r.sender_id);
      const { data: senderProfiles } = await supabase.from("profiles")
        .select("user_id,display_name,username,avatar_url")
        .in("user_id", senderIds);
      const byId = new Map((senderProfiles || []).map((p: any) => [p.user_id, p]));
      setPendingRequests((reqs as any[]).map(r => ({ ...r, sender: byId.get(r.sender_id) })));
    };
    loadRequests();

    // Scoped to this user as receiver — loadRequests() only ever queries
    // pending requests addressed to this user, so an unfiltered `event:"*"`
    // subscription was re-running that query for every partner_requests
    // change from every user on the app (unnecessary global fan-out).
    const ch = supabase.channel(`partner-requests-rt-${user.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "partner_requests", filter: `receiver_id=eq.${user.id}` }, () => loadRequests())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [user, reloadNonce]);

  useEffect(() => {
    const urlInvite = new URLSearchParams(location.search).get("invite");
    const pendingInvite = urlInvite || sessionStorage.getItem("duo-pending-invite");
    if (!user || currentPartner || !pendingInvite) return;
    setJoinCode(pendingInvite.toUpperCase());
    setShowPartnerDialog(true);
  }, [currentPartner, location.search, user]);

  const searchPartners = async () => {
    if (!requireOnline("Searching for people")) return;
    if (!searchTerm.trim()) return;
    setSearching(true);
    const { data, error } = await supabase.rpc("search_users", { search_term: searchTerm.trim() }) as any;
    setSearching(false);
    if (error) { toast({ title: "Search failed", description: "Check your connection and try again.", variant: "destructive" }); return; }
    setSearchResults(data || []);
    if (!data?.length) toast({ title: "No users found" });
  };

  const sendPartnerRequest = async (receiverId: string) => {
    if (!requireOnline("Sending a request")) return;
    if (!user) return;
    hapticMedium();
    const { error } = await supabase.from("partner_requests" as any).insert({ sender_id: user.id, receiver_id: receiverId });
    if (error?.code === "23505") toast({ title: "Request already sent", variant: "destructive" });
    else if (error) toast({ title: "Failed", description: error.message, variant: "destructive" });
    else toast({ title: "Request sent" });
  };

  const acceptRequest = async (req: { id: string; requester_id: string; sender_id?: string; requester_name?: string }) => {
    if (!requireOnline("Accepting a request")) return;
    if (!user) return;
    setRequestActionId(req.id);
    hapticMedium();
    // Phase 8G (Final Release Audit): accept_partner_request and
    // accept_partner_request_v2 are both SECURITY DEFINER Postgres
    // functions — a single PL/pgSQL function body is one transaction, so
    // both are already atomic (v2 is in fact just a thin jsonb-returning
    // wrapper that calls v1; it is not an independent implementation).
    // The previous version of this handler fell through v2's failure into
    // a hand-rolled client-side fallback that performed the same pairing
    // as four separate, non-atomic network round-trips (a status update,
    // an unlink, and two profile writes) — with no check for a conflicting
    // existing partner_id on the sender's side, and no check that the two
    // profile UPDATEs actually succeeded before telling the user they were
    // connected. A partial failure partway through could leave the pairing
    // asymmetric (A → B linked but not B → A), which is exactly the kind
    // of state the RLS "partner" policies and other pairing-dependent
    // features assume never happens. Since both RPCs wrap the same atomic
    // transaction, a failure of both means a real server-side problem
    // (permissions drift, migration not applied, network) that a
    // client-side multi-write fallback cannot safely paper over — so this
    // now surfaces the error and lets the user retry instead of attempting
    // a non-atomic manual pairing.
    const { error } = await supabase.rpc("accept_partner_request" as any, {
      p_request_id: req.id, p_user_id: user.id,
    });
    if (error) {
      const { error: rpc2Err } = await supabase.rpc("accept_partner_request_v2" as any, {
        request_id: req.id, accepting_user_id: user.id,
      });
      if (rpc2Err) {
        toast({
          title: "Couldn't accept request",
          description: "Something went wrong on our end — please try again in a moment.",
          variant: "destructive",
        });
        setRequestActionId(null);
        return;
      }
    }
    const senderId = req.sender_id || req.requester_id;
    setCurrentPartner(senderId);
    const { data: pp } = await supabase.from("profiles").select("display_name,avatar_url").eq("user_id", senderId).single();
    if (pp) { setPartnerName(pp.display_name || "Partner"); setPartnerInitials((pp.display_name || "P").slice(0, 2).toUpperCase()); setPartnerAvatar(pp.avatar_url || null); }
    setRequestActionId(null);
    toast({ title: "Connected! 🎉", description: `Linked with ${pp?.display_name || "your partner"}` });
  };

  const declineRequest = async (id: string) => {
    if (!requireOnline("Declining a request")) return;
    setRequestActionId(id);
    const { error } = await supabase.from("partner_requests" as any).delete().eq("id", id);
    setRequestActionId(null);
    if (error) { toast({ title: "Couldn't decline — try again", variant: "destructive" }); return; }
    toast({ title: "Request declined" });
  };

  const generateInviteLink = async () => {
    if (!requireOnline("Creating an invite")) return;
    if (!user || generatingInvite) return;
    setGeneratingInvite(true);
    hapticMedium();
    const MAX_ATTEMPTS = 5;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const code = generateInviteCode();
      const { error } = await supabase.from("invite_links" as any).insert({ code, creator_id: user.id });
      if (!error) { setInviteCode(code); setShowInviteDialog(true); setGeneratingInvite(false); return; }
      lastError = error;
      if (error.code !== "23505") break;
    }
    setGeneratingInvite(false);
    toast({ title: "Failed to create invite", description: lastError?.message || "Check your connection and try again.", variant: "destructive" });
  };

  const copyInviteCode = () => { navigator.clipboard.writeText(inviteCode); toast({ title: "Code copied" }); };
  const copyInviteLink = () => { navigator.clipboard.writeText(`${window.location.origin}/auth?invite=${inviteCode}`); toast({ title: "Link copied" }); };
  const shareInviteLink = async () => {
    const link = `${window.location.origin}/auth?invite=${inviteCode}`;
    if (navigator.share) { try { await navigator.share({ title: "Join me on DuoSpace", text: "Connect with me on DuoSpace", url: link }); } catch { /* user cancelled share sheet */ } }
    else copyInviteLink();
  };

  const acceptInvite = async () => {
    if (!requireOnline("Joining with a code")) return;
    if (!user || !joinCode.trim() || acceptingInvite) return;
    setAcceptingInvite(true);
    hapticMedium();
    const { data, error } = await supabase.rpc("accept_invite", { p_code: joinCode.trim().toUpperCase(), p_user_id: user.id }) as any;
    setAcceptingInvite(false);
    if (error || data?.error) {
      const msg = data?.error || error?.message || "Something went wrong";
      if (msg.includes("not found") || msg.includes("already used")) toast({ title: "Invalid or expired code", description: "Ask your partner for a fresh invite code.", variant: "destructive" });
      else if (msg.includes("own invite")) toast({ title: "Can't use your own invite", variant: "destructive" });
      else toast({ title: "Failed to connect", description: msg, variant: "destructive" });
      return;
    }
    setCurrentPartner(data.creator_id);
    setPartnerName(data.creator_name || "your partner");
    setPartnerInitials((data.creator_name || "P").slice(0, 2).toUpperCase());
    sessionStorage.removeItem("duo-pending-invite");
    setShowPartnerDialog(false); setJoinCode("");
    if (location.search) navigate("/settings/partner", { replace: true });
    toast({ title: "Connected! 🎉", description: `Linked with ${data.creator_name || "your partner"}` });
  };

  // Sends the unlink REQUEST — it does not unlink anyone by itself. Resolves
  // to false (dialog stays open, so they can retry) only when the request
  // couldn't be sent; true once it's sent or the pairing turned out to be over.
  const sendUnlinkRequest = async (): Promise<boolean> => {
    if (!requireOnline("Unlinking")) return false;
    if (!user || !currentPartner) return false;
    hapticMedium();
    const res = await requestUnlink();

    if (res.error === "NETWORK") {
      toast({ title: "Couldn't send the request", description: "Check your connection and try again.", variant: "destructive" });
      return false;
    }
    if (res.error === "NOT_LINKED") {
      // Already unlinked elsewhere — this screen was stale. Reload to the truth.
      toast({ title: "Already unlinked", description: describeUnlinkError(res.error) });
      finishUnlink();
      return true;
    }
    if (res.error) {
      toast({ title: "Couldn't send the request", description: describeUnlinkError(res.error), variant: "destructive" });
      return false;
    }
    if (res.status === "approved") {
      // Nobody left to ask (one-sided link) or the partner had asked first.
      toast({ title: "Unlinked" });
      finishUnlink();
      return true;
    }
    toast({
      title: "Request sent",
      description: `Waiting for ${partnerName || "your partner"} to approve. You stay linked until they do.`,
    });
    return true;
  };

  const withdrawUnlinkRequest = async () => {
    if (!requireOnline("Withdrawing the request")) return;
    if (!outgoingUnlink || unlinkBusy) return;
    setUnlinkBusy(true);
    const res = await cancelUnlink(outgoingUnlink.id);
    setUnlinkBusy(false);
    if (res.error === "NETWORK") {
      toast({ title: "Couldn't withdraw the request", description: "Check your connection and try again.", variant: "destructive" });
    } else if (res.error) {
      toast({ title: "Nothing to withdraw", description: describeUnlinkError(res.error) });
    } else {
      toast({ title: "Request withdrawn", description: "You're still linked." });
    }
  };

  const answerUnlinkRequest = async (requestId: string, approve: boolean) => {
    if (!requireOnline("Answering the request")) return;
    if (unlinkBusy) return;
    hapticMedium();
    setUnlinkBusy(true);
    const res = await respondToUnlink(requestId, approve);
    setUnlinkBusy(false);
    if (res.error === "NETWORK") {
      toast({ title: "Couldn't send your answer", description: "Check your connection and try again.", variant: "destructive" });
    } else if (res.error) {
      toast({ title: "Couldn't complete that", description: describeUnlinkError(res.error), variant: "destructive" });
    } else if (res.status === "approved") {
      finishUnlink();
    } else {
      toast({ title: "Kept linked", description: `${partnerName || "Your partner"} has been told you'd rather stay linked.` });
    }
  };

  const savePetName = async () => {
    if (!requireOnline("Saving a nickname")) return;
    if (!user || !currentPartner || savingPetName) return;
    setSavingPetName(true);
    const { error } = await supabase.from("profiles").update({ pet_name: petName.trim() || null }).eq("user_id", user.id);
    setSavingPetName(false);
    if (error) { toast({ title: "Couldn't save — try again", variant: "destructive" }); return; }
    setEditingPetName(false); toast({ title: "Saved" });
  };

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }}
      className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-24 bg-background"
    >
      <PageHeader title="Partner" subtitle="Pairing, requests, and your connection" />

      <div className="px-5 pt-5 space-y-3">
        {loading ? (
          <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : loadFailed && !currentPartner ? (
          <div className="bg-card rounded-2xl border border-border/60 p-5 text-center space-y-1">
            <p className="text-sm font-medium">Can't load your pairing right now</p>
            <p className="text-[11px] text-muted-foreground">
              {isOnlineNow() ? "Something went wrong reaching the server." : "You're offline."} Pairing and requests
              need a connection — reopen this screen once you're back online.
            </p>
          </div>
        ) : (
          <>
            {pendingRequests.length > 0 && (
              <div className="space-y-2">
                {pendingRequests.map(req => (
                  <div key={req.id} className="bg-card rounded-2xl border border-primary/20 p-4 flex items-center gap-3">
                    <div className="h-9 w-9 rounded-full bg-primary/20 flex items-center justify-center text-sm font-semibold text-primary">💌</div>
                    <div className="flex-1"><p className="text-sm font-medium">Partner request</p><p className="text-[11px] text-muted-foreground">from {req.sender?.display_name || (req.sender?.username && `@${req.sender.username}`) || `${req.sender_id?.slice(0, 8)}…`}</p></div>
                    <button onClick={() => acceptRequest(req)} disabled={requestActionId === req.id} className="h-7 px-3 rounded-full bg-primary text-primary-foreground text-[11px] disabled:opacity-50 flex items-center gap-1">
                      {requestActionId === req.id ? <Loader2 className="h-3 w-3 animate-spin" /> : "Accept"}
                    </button>
                    <button onClick={() => declineRequest(req.id)} disabled={requestActionId === req.id} className="h-7 px-3 rounded-full bg-muted text-muted-foreground text-[11px] disabled:opacity-50">Decline</button>
                  </div>
                ))}
              </div>
            )}

            {currentPartner ? (
              <div className="space-y-2">
                <div className="bg-card rounded-2xl border border-border/60 p-4 flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-accent/50 flex items-center justify-center text-sm font-semibold text-foreground overflow-hidden">
                    {partnerAvatar ? <img loading="lazy" decoding="async" src={partnerAvatar} alt={partnerName} className="h-full w-full object-cover" /> : partnerInitials}
                  </div>
                  <div className="flex-1"><p className="text-sm font-medium">{partnerName}</p><p className="text-[11px] text-muted-foreground">{outgoingUnlink ? "Unlink requested" : "Connected"}</p></div>
                  {!outgoingUnlink && (
                    <button onClick={() => setShowUnlinkConfirm(true)} className="h-7 px-3 rounded-full bg-muted text-[11px] flex items-center gap-1 text-muted-foreground active:scale-95 transition-transform">
                      <Unlink className="h-3 w-3" /> Unlink
                    </button>
                  )}
                </div>

                {outgoingUnlink && (
                  <div className="bg-card rounded-2xl border border-border/60 p-4 flex items-center gap-3">
                    <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">Waiting for {partnerName || "your partner"} to approve</p>
                      <p className="text-[11px] text-muted-foreground">You stay linked until they allow it. They've been notified.</p>
                    </div>
                    <button onClick={withdrawUnlinkRequest} disabled={unlinkBusy} className="h-7 px-3 rounded-full bg-muted text-[11px] text-muted-foreground disabled:opacity-50 shrink-0">
                      {unlinkBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : "Cancel request"}
                    </button>
                  </div>
                )}

                {incomingUnlinks.map(req => (
                  <div key={req.id} className="bg-card rounded-2xl border border-destructive/30 p-4 space-y-3">
                    <div>
                      <p className="text-sm font-medium">{partnerName || "Your partner"} wants to unlink</p>
                      <p className="text-[11px] text-muted-foreground">It only happens if you allow it. Until then you're still linked.</p>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => answerUnlinkRequest(req.id, false)} disabled={unlinkBusy} className="h-8 flex-1 rounded-full bg-muted text-[11px] text-foreground disabled:opacity-50">Keep us linked</button>
                      <button onClick={() => answerUnlinkRequest(req.id, true)} disabled={unlinkBusy} className="h-8 flex-1 rounded-full bg-destructive text-destructive-foreground text-[11px] disabled:opacity-50 flex items-center justify-center">
                        {unlinkBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : "Allow unlink"}
                      </button>
                    </div>
                  </div>
                ))}
                <div className="bg-card rounded-2xl border border-border/60 p-4">
                  <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-2">Pet name for partner</p>
                  {editingPetName ? (
                    <div className="flex gap-2">
                      <Input value={petName} onChange={e => setPetName(e.target.value)} placeholder="Baby, Love, Jaan..." className="h-8 rounded-full text-sm flex-1" autoFocus />
                      <Button onClick={savePetName} disabled={savingPetName} size="sm" className="rounded-full bg-primary text-primary-foreground h-8 px-4 text-xs">
                        {savingPetName ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
                      </Button>
                    </div>
                  ) : (
                    <button onClick={() => setEditingPetName(true)} className="flex items-center gap-2 text-sm text-foreground">
                      {petName || <span className="text-muted-foreground">Add a pet name…</span>}
                      <Pencil className="h-3 w-3 text-muted-foreground" />
                    </button>
                  )}
                  <p className="text-[10px] text-muted-foreground/70 mt-2">
                    Only you see this — {partnerName || "your partner"} can reveal what you've named them from the Us page, but this won't be shown to them automatically.
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <button onClick={() => { setShowPartnerScanner(true); }}
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
                <button onClick={generateInviteLink} disabled={generatingInvite}
                  className="w-full bg-card rounded-2xl border border-border/60 p-4 flex items-center gap-3 active:scale-[0.98] transition-transform disabled:opacity-60">
                  <UserPlus className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="flex-1 text-left"><p className="text-sm font-medium">Create an invite code</p><p className="text-[11px] text-muted-foreground">Share a code or link for them to join</p></div>
                  {generatingInvite ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                </button>
                <button onClick={() => setShowPartnerDialog(true)}
                  className="w-full bg-card rounded-2xl border border-border/60 p-4 flex items-center gap-3 active:scale-[0.98] transition-transform">
                  <KeyRound className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="flex-1 text-left"><p className="text-sm font-medium">Have an invite code?</p><p className="text-[11px] text-muted-foreground">Enter it to link with your partner</p></div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </button>
              </div>
            )}
          </>
        )}

        <CodeSurpriseEditor partnerId={currentPartner} />
      </div>

      {/* Scan partner's QR */}
      <Dialog open={showPartnerScanner} onOpenChange={setShowPartnerScanner}>
        <DialogContent className="rounded-2xl max-w-[360px]">
          <DialogHeader>
            <DialogTitle className="text-base">Scan partner's QR</DialogTitle>
            <DialogDescription>Point at the QR on their device to link.</DialogDescription>
          </DialogHeader>
          {showPartnerScanner && (
            <QRSignInScanner
              onClose={() => setShowPartnerScanner(false)}
              // The scanner already told the person what happened ("Linked ✓" only when the
              // server confirmed it). This screen just closes the dialog and, when the accounts
              // were linked on the spot, reloads so the new partner shows up.
              onPartnerLinked={(info) => {
                setShowPartnerScanner(false);
                if (info?.immediate) setReloadNonce((n) => n + 1);
              }}
              // "signup_invite" comes back only when the server did NOT see a signed-in scanner,
              // so nobody was linked — never present that as a success.
              onSignupInvite={() => {
                setShowPartnerScanner(false);
                toast({
                  title: "Couldn't link yet",
                  description: "This device wasn't recognised as signed in. Sign in again, then scan once more.",
                  variant: "destructive",
                });
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Search partner */}
      <Dialog open={showSearchPartner} onOpenChange={setShowSearchPartner}>
        <DialogContent className="rounded-2xl max-w-[340px]">
          <DialogHeader><DialogTitle className="text-base">Find your partner</DialogTitle><DialogDescription>Search by username or phone</DialogDescription></DialogHeader>
          <div className="flex gap-2">
            <Input value={searchTerm} onChange={e => setSearchTerm(e.target.value)} placeholder="Username or +1234567890" className="rounded-xl flex-1" onKeyDown={e => e.key === "Enter" && searchPartners()} />
            <Button onClick={searchPartners} disabled={searching} size="sm" className="rounded-xl bg-primary text-primary-foreground">
              {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            </Button>
          </div>
          {searchResults.length > 0 && (
            <div className="space-y-2 mt-2">
              {searchResults.map((r: any) => (
                <div key={r.user_id} className="flex items-center gap-3 bg-muted/40 rounded-xl p-3">
                  {r.avatar_url ? <img loading="lazy" decoding="async" src={r.avatar_url} className="h-8 w-8 rounded-full object-cover" />
                    : <div className="h-8 w-8 rounded-full bg-accent flex items-center justify-center text-xs font-semibold text-accent-foreground">{(r.display_name || "?").charAt(0).toUpperCase()}</div>}
                  <div className="flex-1 min-w-0"><p className="text-sm font-medium truncate">{r.display_name}</p>{r.username && <p className="text-[10px] text-muted-foreground">@{r.username}</p>}</div>
                  <Button onClick={() => sendPartnerRequest(r.user_id)} size="sm" className="rounded-full h-9 px-3 text-[10px] bg-primary text-primary-foreground"><UserPlus className="h-3 w-3 mr-1" /> Request</Button>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Enter invite code */}
      <Dialog open={showPartnerDialog} onOpenChange={setShowPartnerDialog}>
        <DialogContent className="rounded-2xl max-w-[340px]">
          <DialogHeader><DialogTitle className="text-base">Enter invite code</DialogTitle><DialogDescription>Ask your partner for their invite code</DialogDescription></DialogHeader>
          <div className="flex gap-2">
            <Input value={joinCode} onChange={e => setJoinCode(e.target.value.toUpperCase())} placeholder="ABCD1234" className="rounded-xl flex-1 uppercase tracking-widest text-center" maxLength={8} onKeyDown={e => e.key === "Enter" && acceptInvite()} />
            <Button onClick={acceptInvite} disabled={acceptingInvite || !joinCode.trim()} size="sm" className="rounded-xl bg-primary text-primary-foreground">
              {acceptingInvite ? <Loader2 className="h-4 w-4 animate-spin" /> : "Connect"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Invite generated */}
      <Dialog open={showInviteDialog} onOpenChange={setShowInviteDialog}>
        <DialogContent className="rounded-2xl max-w-[340px]">
          <DialogHeader><DialogTitle className="text-base">Invite created</DialogTitle><DialogDescription>Share this code or link with your partner</DialogDescription></DialogHeader>
          <div className="bg-muted rounded-xl px-4 py-3 text-center font-mono text-lg tracking-widest select-all">{inviteCode}</div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={copyInviteCode} className="flex-1 rounded-xl text-xs"><Copy className="h-3.5 w-3.5 mr-1.5" /> Copy code</Button>
            <Button variant="outline" onClick={copyInviteLink} className="flex-1 rounded-xl text-xs"><Copy className="h-3.5 w-3.5 mr-1.5" /> Copy link</Button>
          </div>
          <Button onClick={shareInviteLink} className="w-full rounded-xl bg-primary text-primary-foreground text-xs"><Share2 className="h-3.5 w-3.5 mr-1.5" /> Share</Button>
        </DialogContent>
      </Dialog>

      <ConfirmActionDialog
        open={showUnlinkConfirm}
        onOpenChange={setShowUnlinkConfirm}
        title="Ask to unlink?"
        whatHappens={`We'll send ${partnerName || "your partner"} a request to unlink. You stay linked until they approve it — if they decline, or don't answer, nothing changes.`}
        approvalNote={`${partnerName || "Your partner"} gets a notification and must allow it before anything is unlinked.`}
        dataAffected="Existing chat history, photos, and shared content are kept on both accounts — this only removes the active link between you."
        reversible={true}
        reversibleNote="reconnect anytime with a new invite or request"
        authRequired={false}
        confirmLabel="Send request"
        onConfirm={sendUnlinkRequest}
      />
    </motion.div>
  );
};

export default PartnerSettings;

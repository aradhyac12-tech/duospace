import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import PageHeader from "@/components/PageHeader";
import {
  Scan, Search, ChevronRight, UserPlus, Unlink, Pencil, Loader2, Copy, Share2, KeyRound,
} from "lucide-react";
import { useNavigate, useLocation } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
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

/**
 * Partner pairing/linking is its own page: it has network round-trips
 * (search, request, accept), a scanner, and a destructive unlink action —
 * enough moving parts that it deserved a dedicated screen rather than one
 * collapsible section on the Settings hub.
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

  const [currentPartner, setCurrentPartner] = useState<string | null>(null);
  const [partnerName, setPartnerName] = useState("");
  const [partnerInitials, setPartnerInitials] = useState("?");
  const [partnerAvatar, setPartnerAvatar] = useState<string | null>(null);
  const [petName, setPetName] = useState("");
  const [editingPetName, setEditingPetName] = useState(false);
  const [savingPetName, setSavingPetName] = useState(false);

  const [searchTerm, setSearchTerm] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [pendingRequests, setPendingRequests] = useState<any[]>([]);
  const [requestActionId, setRequestActionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      const { data, error } = await supabase.from("profiles")
        .select("partner_id,pet_name")
        .eq("user_id", user.id).single();
      if (error) { setLoading(false); return; }
      if (data?.pet_name) setPetName(data.pet_name);
      if (data?.partner_id) {
        setCurrentPartner(data.partner_id);
        const { data: pp } = await supabase.from("profiles")
          .select("display_name,avatar_url").eq("user_id", data.partner_id).single();
        if (pp) {
          setPartnerName(pp.display_name || "Partner");
          setPartnerInitials((pp.display_name || "P").slice(0, 2).toUpperCase());
          setPartnerAvatar(pp.avatar_url || null);
        }
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

    const ch = supabase.channel("partner-requests-rt")
      .on("postgres_changes", { event: "*", schema: "public", table: "partner_requests" }, () => loadRequests())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [user]);

  useEffect(() => {
    const urlInvite = new URLSearchParams(location.search).get("invite");
    const pendingInvite = urlInvite || sessionStorage.getItem("duo-pending-invite");
    if (!user || currentPartner || !pendingInvite) return;
    setJoinCode(pendingInvite.toUpperCase());
    setShowPartnerDialog(true);
  }, [currentPartner, location.search, user]);

  const searchPartners = async () => {
    if (!searchTerm.trim()) return;
    setSearching(true);
    const { data, error } = await supabase.rpc("search_users", { search_term: searchTerm.trim() }) as any;
    setSearching(false);
    if (error) { toast({ title: "Search failed", description: "Check your connection and try again.", variant: "destructive" }); return; }
    setSearchResults(data || []);
    if (!data?.length) toast({ title: "No users found" });
  };

  const sendPartnerRequest = async (receiverId: string) => {
    if (!user) return;
    hapticMedium();
    const { error } = await supabase.from("partner_requests" as any).insert({ sender_id: user.id, receiver_id: receiverId });
    if (error?.code === "23505") toast({ title: "Request already sent", variant: "destructive" });
    else if (error) toast({ title: "Failed", description: error.message, variant: "destructive" });
    else toast({ title: "Request sent" });
  };

  const acceptRequest = async (req: { id: string; requester_id: string; sender_id?: string; requester_name?: string }) => {
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
    setRequestActionId(id);
    const { error } = await supabase.from("partner_requests" as any).delete().eq("id", id);
    setRequestActionId(null);
    if (error) { toast({ title: "Couldn't decline — try again", variant: "destructive" }); return; }
    toast({ title: "Request declined" });
  };

  const generateInviteLink = async () => {
    if (!user || generatingInvite) return;
    setGeneratingInvite(true);
    hapticMedium();
    const MAX_ATTEMPTS = 5;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const code = Math.random().toString(36).substring(2, 10).toUpperCase();
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

  const unlinkPartner = async () => {
    if (!user || !currentPartner) return;
    hapticMedium();
    const { error } = await supabase.rpc("unlink_partner", { p_user_id: user.id }) as any;
    if (error) { toast({ title: "Failed to unlink", description: "Check your connection and try again.", variant: "destructive" }); return; }
    setCurrentPartner(null); setPartnerName(""); setPartnerInitials("?"); setPartnerAvatar(null);
    toast({ title: "Unlinked" });
  };

  const savePetName = async () => {
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
                  <div className="flex-1"><p className="text-sm font-medium">{partnerName}</p><p className="text-[11px] text-muted-foreground">Connected</p></div>
                  <button onClick={() => setShowUnlinkConfirm(true)} className="h-7 px-3 rounded-full bg-muted text-[11px] flex items-center gap-1 text-muted-foreground active:scale-95 transition-transform">
                    <Unlink className="h-3 w-3" /> Unlink
                  </button>
                </div>
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
              onPartnerLinked={() => { setShowPartnerScanner(false); toast({ title: "Linked ✓", description: "Waiting for partner to finish signup." }); }}
              onSignupInvite={() => { setShowPartnerScanner(false); toast({ title: "Linked ✓", description: "Waiting for partner to finish signup." }); }}
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
        title="Unlink from partner?"
        whatHappens={`You and ${partnerName || "your partner"} will no longer be connected. Either of you can send a new invite or request to reconnect later.`}
        dataAffected="Existing chat history, photos, and shared content are kept on both accounts — this only removes the active link between you."
        reversible={true}
        reversibleNote="reconnect anytime with a new invite or request"
        authRequired={false}
        confirmLabel="Unlink"
        onConfirm={unlinkPartner}
      />
    </motion.div>
  );
};

export default PartnerSettings;

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { supabase } from "@/integrations/supabase/appClient";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  ChevronRight, ChevronLeft, User, Phone, Heart, Calendar, AtSign,
  Scan, Search, QrCode, UserPlus, Loader2, Check,
} from "lucide-react";
import { hapticSelection, hapticMedium } from "@/lib/haptics";
import QRSignInScanner from "@/components/auth/QRSignInScanner";
import QRSignInDisplay from "@/components/auth/QRSignInDisplay";
import DailyKeyManager from "@/components/DailyKeyManager";

const genderOptions = [
  { value: "male", label: "Male", emoji: "👨" },
  { value: "female", label: "Female", emoji: "👩" },
  { value: "non-binary", label: "Non-binary", emoji: "🧑" },
];

interface OnboardingProps {
  onComplete: () => void;
}

// One entry per screen the wizard can show, in the order they're evaluated.
// "cycle" only appears for gender === "female"; "partner" only appears if
// the profile check on mount finds no partner_id yet — both are computed
// once profileLoaded flips true (see below) so the step count/progress
// dots never shift mid-flow.
type StepKind = "name" | "gender" | "phone" | "cycle" | "username" | "partner" | "dailykey";

type PartnerPanel = "menu" | "scan" | "display" | "search";

// Motion-wrapped Button so every primary/skip/back action gets a consistent
// tap/hover micro-interaction without touching each call site individually.
const MotionButton = motion(Button);

// Step-transition variants, direction-aware: forward advances slide in
// from the right (and the outgoing step exits left), back does the mirror
// — the classic wizard feel instead of a flat cross-fade. `dir` is 1 for
// forward, -1 for backward, threaded in via AnimatePresence's custom prop.
const stepVariants = {
  enter: (dir: number) => ({ opacity: 0, x: dir >= 0 ? 36 : -36, scale: 0.98 }),
  center: { opacity: 1, x: 0, scale: 1 },
  exit: (dir: number) => ({ opacity: 0, x: dir >= 0 ? -36 : 36, scale: 0.98 }),
};

const Onboarding = ({ onComplete }: OnboardingProps) => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [step, setStep] = useState(0);
  // Tracks whether the most recent step change was forward or backward, so
  // the AnimatePresence transition below can slide the right direction.
  const [direction, setDirection] = useState(1);
  const [displayName, setDisplayName] = useState(user?.user_metadata?.full_name || "");
  const [gender, setGender] = useState<string>("");
  const [phone, setPhone] = useState("");
  const [cycleLength, setCycleLength] = useState("28");
  const [periodLength, setPeriodLength] = useState("5");
  const [lastPeriodDate, setLastPeriodDate] = useState("");
  const [saving, setSaving] = useState(false);

  // Username step
  const [username, setUsername] = useState("");
  const [savingUsername, setSavingUsername] = useState(false);
  const [usernameSaved, setUsernameSaved] = useState(false);

  // Partner-link step — same three mechanisms as Settings → Partner (scan
  // their QR, show mine, search by username), trimmed to just those three
  // per the onboarding brief. None of them block onboarding: a QR scan/
  // search only sends a request or a pending link, the actual pairing
  // completes later whether or not the person is still on this screen.
  const [partnerLinked, setPartnerLinked] = useState<boolean | null>(null);
  const [partnerPanel, setPartnerPanel] = useState<PartnerPanel>("menu");
  const [partnerActionDone, setPartnerActionDone] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [requestedIds, setRequestedIds] = useState<Set<string>>(new Set());

  // Gate the whole wizard on one cheap profile read so the step count
  // (progress dots) and the conditional "partner" step are both known
  // up front — recomputing them mid-flow (e.g. the partner check
  // resolving after the person has already stepped past where "partner"
  // would have been) would silently shift step numbers under them.
  const [profileLoaded, setProfileLoaded] = useState(false);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("profiles")
        .select("username,partner_id")
        .eq("user_id", user.id).single();
      if (cancelled) return;
      if (data?.username) setUsername(data.username);
      setPartnerLinked(!!data?.partner_id);
      setProfileLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [user]);

  const isFemale = gender === "female";

  const stepKinds: StepKind[] = [
    "name", "gender", "phone",
    ...(isFemale ? (["cycle"] as StepKind[]) : []),
    "username",
    ...(partnerLinked === false ? (["partner"] as StepKind[]) : []),
    "dailykey",
  ];
  const totalSteps = stepKinds.length;
  const kind = stepKinds[step];

  const stepMeta: Record<StepKind, { title: string; icon: typeof User }> = {
    name: { title: "What should we call you?", icon: User },
    gender: { title: "Your gender", icon: Heart },
    phone: { title: "Your contact number", icon: Phone },
    cycle: { title: "Cycle tracking (optional)", icon: Calendar },
    username: { title: "Pick a username", icon: AtSign },
    partner: { title: "Link with your partner", icon: UserPlus },
    dailykey: { title: "Add your Daily.co key (optional)", icon: QrCode },
  };

  const canProceed = () => {
    if (kind === "name") return displayName.trim().length > 0;
    if (kind === "gender") return gender.length > 0;
    return true; // every other step is optional/skippable
  };

  const cleanUsername = (raw: string) => raw.trim().toLowerCase().replace(/[^a-z0-9_.]/g, "");

  const saveUsername = async (): Promise<boolean> => {
    const clean = cleanUsername(username);
    if (!clean) return true; // nothing entered — treat as skip
    if (clean.length < 3) {
      toast({ title: "Username too short (min 3 chars)", variant: "destructive" });
      return false;
    }
    setSavingUsername(true);
    const { error } = await supabase.from("profiles").update({ username: clean }).eq("user_id", user!.id);
    setSavingUsername(false);
    if (error?.code === "23505") {
      toast({ title: "Username taken", description: "Try a different one.", variant: "destructive" });
      return false;
    }
    if (error) {
      toast({ title: "Couldn't save username", description: "Check your connection and try again.", variant: "destructive" });
      return false;
    }
    setUsername(clean);
    setUsernameSaved(true);
    return true;
  };

  const searchPartners = async () => {
    if (!searchTerm.trim()) return;
    setSearching(true);
    const { data, error } = await supabase.rpc("search_users", { search_term: searchTerm.trim() }) as any;
    setSearching(false);
    if (error) { toast({ title: "Search failed", description: "Check your connection and try again.", variant: "destructive" }); return; }
    setSearchResults((data || []).filter((r: any) => r.user_id !== user?.id));
    if (!data?.length) toast({ title: "No users found" });
  };

  const sendPartnerRequest = async (receiverId: string) => {
    if (!user) return;
    hapticMedium();
    const { error } = await supabase.from("partner_requests" as any).insert({ sender_id: user.id, receiver_id: receiverId });
    if (error?.code === "23505") toast({ title: "Request already sent" });
    else if (error) { toast({ title: "Failed", description: error.message, variant: "destructive" }); return; }
    else toast({ title: "Request sent" });
    setRequestedIds(prev => new Set(prev).add(receiverId));
    setPartnerActionDone(true);
  };

  const handleNext = async () => {
    if (kind === "username") {
      const ok = await saveUsername();
      if (!ok) return;
    }

    if (step < totalSteps - 1) {
      hapticMedium();
      setDirection(1);
      setStep(step + 1);
      setPartnerPanel("menu");
      setPartnerActionDone(false);
      return;
    }

    // Last step ("dailykey") — everything else has already been saved
    // incrementally (name/gender/phone/cycle in the final profile update
    // below, username via saveUsername() above, the Daily.co key by
    // DailyKeyManager's own Save button, any partner action by
    // sendPartnerRequest/QR flows). This final write only needs the
    // core profile fields the original onboarding always saved.
    setSaving(true);
    const { error } = await supabase
      .from("profiles")
      .update({
        display_name: displayName.trim(),
        gender,
        phone_number: phone.trim() || null,
      })
      .eq("user_id", user!.id);

    if (error) {
      toast({ title: "Couldn't save profile", description: error.message, variant: "destructive" });
      setSaving(false);
      return;
    }

    if (isFemale && lastPeriodDate) {
      const { error: cycleError } = await supabase.from("menstrual_cycles").insert({
        user_id: user!.id,
        cycle_start_date: lastPeriodDate,
        cycle_length: parseInt(cycleLength) || 28,
        period_length: parseInt(periodLength) || 5,
      } as any);
      if (cycleError) {
        toast({ title: "Profile saved, but cycle info didn't", description: "You can add it again later.", variant: "destructive" });
      }
    }

    toast({ title: "Welcome! 🎉", description: "Your profile is all set" });
    onComplete();
    setSaving(false);
  };

  const handleSkip = () => {
    if (step < totalSteps - 1) {
      setDirection(1);
      setStep(step + 1);
      setPartnerPanel("menu");
      setPartnerActionDone(false);
    } else {
      handleNext();
    }
  };

  if (!profileLoaded) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const meta = stepMeta[kind];

  return (
    <div className="min-h-dvh flex items-center justify-center bg-background px-6">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 260, damping: 26 }}
        className="w-full max-w-sm space-y-8"
      >
        <div className="text-center space-y-2">
          <motion.h1
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05, duration: 0.3 }}
            className="text-3xl font-serif tracking-tight"
          >
            Let's set up your profile
          </motion.h1>
          <div className="flex justify-center gap-2 mt-4 flex-wrap">
            {stepKinds.map((_, i) => (
              <motion.div
                key={i}
                layout
                initial={false}
                animate={{
                  width: i <= step ? 32 : 16,
                  opacity: i <= step ? 1 : 0.6,
                  scale: i === step ? 1.08 : 1,
                }}
                transition={{ type: "spring", stiffness: 420, damping: 30 }}
                className={`h-1.5 rounded-full ${i <= step ? "bg-primary" : "bg-muted"}`}
              />
            ))}
          </div>
        </div>

        <AnimatePresence mode="wait" custom={direction} initial={false}>
          <motion.div
            key={step}
            custom={direction}
            variants={stepVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ type: "spring", stiffness: 340, damping: 32 }}
            className="space-y-6 max-h-[62vh] overflow-y-auto overscroll-contain px-0.5"
          >
            <div className="text-center">
              <motion.div
                key={`icon-${step}`}
                initial={{ scale: 0.5, rotate: -12, opacity: 0 }}
                animate={{ scale: 1, rotate: 0, opacity: 1 }}
                transition={{ type: "spring", stiffness: 420, damping: 18, delay: 0.05 }}
                className="h-14 w-14 rounded-2xl bg-accent flex items-center justify-center mx-auto mb-4"
              >
                <meta.icon className="h-6 w-6 text-accent-foreground" />
              </motion.div>
              <motion.h2
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1, duration: 0.25 }}
                className="text-lg font-medium"
              >
                {meta.title}
              </motion.h2>
            </div>

            {kind === "name" && (
              <Input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your name"
                className="h-12 rounded-xl bg-card border-border text-center text-lg"
                autoFocus
              />
            )}

            {kind === "gender" && (
              <div className="grid grid-cols-3 gap-3">
                {genderOptions.map((opt) => (
                  <motion.button
                    key={opt.value}
                    onClick={() => { hapticSelection(); setGender(opt.value); }}
                    whileTap={{ scale: 0.94 }}
                    animate={gender === opt.value ? { scale: 1.03 } : { scale: 1 }}
                    transition={{ type: "spring", stiffness: 500, damping: 22 }}
                    className={`rounded-2xl border-2 p-4 flex flex-col items-center gap-2 transition-colors duration-200 ${
                      gender === opt.value
                        ? "border-primary bg-accent/10"
                        : "border-border bg-card"
                    }`}
                  >
                    <motion.span
                      className="text-3xl"
                      animate={gender === opt.value ? { scale: [1, 1.25, 1] } : { scale: 1 }}
                      transition={{ duration: 0.35 }}
                    >
                      {opt.emoji}
                    </motion.span>
                    <span className="text-xs font-medium">{opt.label}</span>
                  </motion.button>
                ))}
              </div>
            )}

            {kind === "phone" && (
              <div className="space-y-2">
                <Input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+1 (555) 000-0000"
                  type="tel"
                  className="h-12 rounded-xl bg-card border-border text-center text-lg"
                  autoFocus
                />
                <p className="text-[11px] text-muted-foreground text-center">Optional — for account recovery</p>
              </div>
            )}

            {kind === "cycle" && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">Last period start date</label>
                  <Input
                    value={lastPeriodDate}
                    onChange={(e) => setLastPeriodDate(e.target.value)}
                    type="date"
                    className="h-12 rounded-xl bg-card border-border text-center"
                    autoFocus
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">Cycle length (days)</label>
                    <Input
                      value={cycleLength}
                      onChange={(e) => setCycleLength(e.target.value)}
                      type="number"
                      min="20" max="45"
                      className="h-10 rounded-xl bg-card border-border text-center"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">Period length (days)</label>
                    <Input
                      value={periodLength}
                      onChange={(e) => setPeriodLength(e.target.value)}
                      type="number"
                      min="2" max="10"
                      className="h-10 rounded-xl bg-card border-border text-center"
                    />
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground text-center">
                  This helps your partner know when to pamper you 💕<br/>
                  You can skip this and add it later.
                </p>
              </div>
            )}

            {kind === "username" && (
              <div className="space-y-2">
                <div className="relative">
                  <AtSign className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    value={username}
                    onChange={(e) => { setUsername(cleanUsername(e.target.value)); setUsernameSaved(false); }}
                    placeholder="username"
                    className="h-12 rounded-xl bg-card border-border text-center text-lg pl-9"
                    autoFocus
                    autoCapitalize="none"
                    autoCorrect="off"
                  />
                  {usernameSaved && (
                    <Check className="absolute right-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-primary" />
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground text-center">
                  Letters, numbers, underscores and dots · lets your partner find you later
                </p>
              </div>
            )}

            {kind === "partner" && (
              <div className="space-y-2">
                {partnerActionDone ? (
                  <div className="flex flex-col items-center gap-3 py-4 text-center">
                    <div className="h-12 w-12 rounded-full bg-primary/15 flex items-center justify-center">
                      <Check className="h-6 w-6 text-primary" />
                    </div>
                    <p className="text-sm text-muted-foreground max-w-[260px]">
                      You're all set here — they'll be linked as your partner once this is confirmed on their end.
                    </p>
                  </div>
                ) : partnerPanel === "menu" ? (
                  <div className="space-y-2">
                    <button
                      onClick={() => { hapticMedium(); setPartnerPanel("scan"); }}
                      className="w-full bg-card rounded-2xl border border-border/60 p-4 flex items-center gap-3 active:scale-[0.98] transition-transform"
                    >
                      <Scan className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="flex-1 text-left">
                        <p className="text-sm font-medium">Scan partner's QR</p>
                        <p className="text-[11px] text-muted-foreground">Open camera and scan their code</p>
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </button>
                    <button
                      onClick={() => { hapticMedium(); setPartnerPanel("display"); }}
                      className="w-full bg-card rounded-2xl border border-border/60 p-4 flex items-center gap-3 active:scale-[0.98] transition-transform"
                    >
                      <QrCode className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="flex-1 text-left">
                        <p className="text-sm font-medium">Show my QR</p>
                        <p className="text-[11px] text-muted-foreground">Let them scan you instead</p>
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </button>
                    <button
                      onClick={() => { hapticMedium(); setPartnerPanel("search"); }}
                      className="w-full bg-card rounded-2xl border border-border/60 p-4 flex items-center gap-3 active:scale-[0.98] transition-transform"
                    >
                      <Search className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="flex-1 text-left">
                        <p className="text-sm font-medium">Find by username</p>
                        <p className="text-[11px] text-muted-foreground">Search for your partner by username</p>
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <button
                      onClick={() => setPartnerPanel("menu")}
                      className="flex items-center gap-1 text-xs text-muted-foreground"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" /> Back
                    </button>

                    {partnerPanel === "scan" && (
                      <QRSignInScanner
                        onClose={() => setPartnerPanel("menu")}
                        onPartnerLinked={() => { setPartnerActionDone(true); toast({ title: "Linked ✓", description: "Waiting for partner to finish signup." }); }}
                        onSignupInvite={() => { setPartnerActionDone(true); toast({ title: "Linked ✓", description: "Waiting for partner to finish signup." }); }}
                      />
                    )}

                    {partnerPanel === "display" && (
                      <QRSignInDisplay
                        mode="signup_invite"
                        onClose={() => setPartnerPanel("menu")}
                        onRedeemed={() => { setPartnerActionDone(true); toast({ title: "Scanned ✓", description: "They're finishing signup on their device." }); }}
                      />
                    )}

                    {partnerPanel === "search" && (
                      <div className="space-y-3">
                        <div className="flex gap-2">
                          <Input
                            value={searchTerm}
                            onChange={e => setSearchTerm(e.target.value)}
                            placeholder="Username or +1234567890"
                            className="rounded-xl flex-1"
                            onKeyDown={e => e.key === "Enter" && searchPartners()}
                            autoFocus
                          />
                          <Button onClick={searchPartners} disabled={searching} size="sm" className="rounded-xl bg-primary text-primary-foreground">
                            {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                          </Button>
                        </div>
                        {searchResults.length > 0 && (
                          <div className="space-y-2">
                            {searchResults.map((r: any) => (
                              <div key={r.user_id} className="flex items-center gap-3 bg-muted/40 rounded-xl p-3">
                                {r.avatar_url
                                  ? <img loading="lazy" decoding="async" src={r.avatar_url} className="h-8 w-8 rounded-full object-cover" />
                                  : <div className="h-8 w-8 rounded-full bg-accent flex items-center justify-center text-xs font-semibold text-accent-foreground">{(r.display_name || "?").charAt(0).toUpperCase()}</div>}
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-medium truncate">{r.display_name}</p>
                                  {r.username && <p className="text-[10px] text-muted-foreground">@{r.username}</p>}
                                </div>
                                <Button
                                  onClick={() => sendPartnerRequest(r.user_id)}
                                  disabled={requestedIds.has(r.user_id)}
                                  size="sm"
                                  className="rounded-full h-9 px-3 text-[10px] bg-primary text-primary-foreground"
                                >
                                  {requestedIds.has(r.user_id) ? <Check className="h-3 w-3" /> : <><UserPlus className="h-3 w-3 mr-1" /> Request</>}
                                </Button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {kind === "dailykey" && (
              <div className="space-y-1">
                <DailyKeyManager />
                <p className="text-[11px] text-muted-foreground text-center pt-1">
                  Needed for calls to work — either of you can add one, and you can always add or change it later in Settings.
                </p>
              </div>
            )}
          </motion.div>
        </AnimatePresence>

        <MotionButton
          onClick={() => handleNext()}
          disabled={!canProceed() || saving || savingUsername}
          whileTap={{ scale: 0.97 }}
          whileHover={{ scale: 1.01 }}
          transition={{ type: "spring", stiffness: 500, damping: 24 }}
          className="w-full h-12 rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 text-sm font-medium gap-2"
        >
          {step === totalSteps - 1
            ? (saving ? "Saving..." : "Let's go!")
            : (savingUsername ? "Saving..." : "Continue")}
          <AnimatePresence initial={false}>
            {step < totalSteps - 1 && (
              <motion.span
                initial={{ x: -4, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: -4, opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="inline-flex"
              >
                <ChevronRight className="h-4 w-4" />
              </motion.span>
            )}
          </AnimatePresence>
        </MotionButton>

        {(kind === "phone" || kind === "cycle" || kind === "username" || kind === "partner" || kind === "dailykey") && (
          <motion.button
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            whileTap={{ scale: 0.96 }}
            onClick={handleSkip}
            disabled={saving || savingUsername}
            className="w-full text-center text-xs text-muted-foreground underline underline-offset-2"
          >
            Skip for now
          </motion.button>
        )}

        {step > 0 && (
          <motion.button
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            whileTap={{ scale: 0.96 }}
            onClick={() => { setDirection(-1); setStep(step - 1); setPartnerPanel("menu"); setPartnerActionDone(false); }}
            className="w-full text-center text-xs text-muted-foreground"
          >
            Go back
          </motion.button>
        )}
      </motion.div>
    </div>
  );
};

export default Onboarding;

import PageHeader from "@/components/PageHeader";
import { motion, AnimatePresence } from "framer-motion";
import { Smile, Zap, Plus, X, Send, Settings, Heart, TrendingUp, Tag, Eye } from "lucide-react";
import { getPronouns, type Gender } from "@/lib/pronouns";
import MemoryWall from "@/components/MemoryWall";
import { useAuth } from "@/hooks/useAuth";
import { useTheme } from "@/contexts/ThemeContext";
import { supabase } from "@/integrations/supabase/client";
import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { hapticLight, hapticMedium, hapticNotification, hapticWarning, hapticError } from "@/lib/haptics";
import { Shimmer } from "@/components/skeletons/Shimmer";
import { ErrorCard } from "@/components/errors/ErrorCard";
import AmbientGlow from "@/components/AmbientGlow";
import { useErrorManager } from "@/lib/errors/useErrorManager";
import type { DuoSpaceErrorPayload } from "@/lib/errors/types";
import MoodHistory from "@/components/MoodHistory";

const dailyQuestions = [
  "What made you smile today?",
  "What's one thing you love about us?",
  "Describe your perfect day together.",
  "What song reminds you of me?",
  "What's a dream trip you'd take together?",
  "What's your favourite memory of us?",
  "If we could do anything right now, what would it be?",
  "What's something small I do that means a lot to you?",
  "What's a place you'd love us to visit together?",
  "What's a habit of mine you find endearing?",
];

const getQuestionOfDay = () => {
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86400000);
  return dailyQuestions[dayOfYear % dailyQuestions.length];
};

// B6 Fix: Safe time-ago that never returns NaN
const safeTimeAgo = (dateStr: string | null | undefined): string => {
  if (!dateStr) return "";
  const ms = Date.now() - new Date(dateStr).getTime();
  if (isNaN(ms) || ms < 0) return "";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
};

const Us = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { appSettings } = useTheme();
  const { capture } = useErrorManager("Us");
  const [searchParams, setSearchParams] = useSearchParams();
  const [profile, setProfile] = useState<any>(null);
  const [partnerProfile, setPartnerProfile] = useState<any>(null);
  const [partnerId, setPartnerId] = useState<string | null>(null);
  const [countdowns, setCountdowns] = useState<any[]>([]);
  const [showCountdownDialog, setShowCountdownDialog] = useState(false);
  const [newCountdown, setNewCountdown] = useState({ title: "", date: "", emoji: "🎉" });
  const [savingCountdown, setSavingCountdown] = useState(false);
  const [dailyAnswer, setDailyAnswer] = useState("");
  const [myAnswer, setMyAnswer] = useState<string | null>(null);
  const [partnerAnswer, setPartnerAnswer] = useState<string | null>(null);
  const [streak, setStreak] = useState(0);
  const [moodEmoji, setMoodEmoji] = useState("😊");
  const [moodText, setMoodText] = useState("");
  const [showMoodDialog, setShowMoodDialog] = useState(false);
  // Nickname reveal (Us page): partnerProfile.pet_name is the nickname MY
  // partner privately set for ME (see the pet_name semantics note near the
  // partner-card render below) — the one legitimate place in the app that
  // reads it, and only on an explicit tap, not shown passively anywhere.
  const [petNameRevealed, setPetNameRevealed] = useState(false);
  const [submittingAnswer, setSubmittingAnswer] = useState(false);
  // F1: Partner online presence
  const [partnerOnline, setPartnerOnline] = useState(false);
  // Loading vs empty distinction for the hub's initial fetch — without it
  // "No countdowns yet" and an empty streak briefly render as truth on
  // every cold load, and permanently if the fetch actually failed.
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<DuoSpaceErrorPayload | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  // Deep link: /us?focus=mood or /us?focus=countdown opens the matching
  // dialog straight away — the intended target for a future "set your
  // mood" / "add a countdown" notification or shortcut (see
  // docs/RELATIONSHIP_FEATURE_QA.md for the honest gap note: nothing sends
  // that payload yet, this is the receiving half only).
  const focus = searchParams.get("focus");
  const focusMemoryId = searchParams.get("memory");
  const consumedFocusRef = useRef(false);
  const [confirmDeleteCountdown, setConfirmDeleteCountdown] = useState<{ id: string; title: string } | null>(null);
  const [showMoodHistory, setShowMoodHistory] = useState(false);

  const todayQuestion = getQuestionOfDay();

  // B10 Fix: Move streak to a lean query — count distinct active days in last 30
  const calcStreak = useCallback(async (uid: string, pid: string | null) => {
    if (!pid) return 0;
    // Count days with any message sent or received in last 365 days
    const since = new Date();
    since.setDate(since.getDate() - 365);

    const { data } = await supabase
      .from("messages")
      .select("created_at")
      .or(`and(sender_id.eq.${uid},receiver_id.eq.${pid}),and(sender_id.eq.${pid},receiver_id.eq.${uid})`)
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: false })
      .limit(365);

    if (!data) return 0;
    const activeDays = new Set(data.map(m => m.created_at.split("T")[0]));
    let s = 0;
    const today = new Date();
    for (let i = 0; i < 365; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const ds = d.toISOString().split("T")[0];
      if (activeDays.has(ds)) s++;
      else if (i > 0) break;
    }
    return s;
  }, []);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const { data: p, error: pErr } = await supabase.from("profiles").select("id,user_id,display_name,username,avatar_url,partner_id,pet_name,gender,mood_emoji,mood_text,mood_updated_at,public_key,gallery_shared,created_at,updated_at").eq("user_id", user.id).single();
        if (pErr) throw pErr;
        if (cancelled) return;
        if (p) {
          setProfile(p);
          setMoodEmoji(p.mood_emoji || "😊");
          setMoodText(p.mood_text || "");
          setPartnerId(p.partner_id);

          if (p.partner_id) {
            const { data: pp, error: ppErr } = await supabase.from("profiles").select("id,user_id,display_name,username,avatar_url,partner_id,pet_name,gender,mood_emoji,mood_text,mood_updated_at,public_key,gallery_shared,created_at,updated_at").eq("user_id", p.partner_id).single();
            if (ppErr) throw ppErr;
            if (cancelled) return;
            if (pp) setPartnerProfile(pp);

            // B2 Fix: filter countdowns to only this couple's creator IDs
            const { data: cd, error: cdErr } = await supabase
              .from("countdowns")
              .select("id,creator_id,title,emoji,target_date,created_at")
              .in("creator_id", [user.id, p.partner_id])
              .order("target_date", { ascending: true });
            if (cdErr) throw cdErr;
            if (cancelled) return;
            if (cd) setCountdowns(cd);

            const today = new Date().toISOString().split("T")[0];
            const { data: myA } = await supabase.from("daily_answers").select("answer")
              .eq("user_id", user.id).eq("question_date", today).maybeSingle();
            if (cancelled) return;
            if (myA) setMyAnswer(myA.answer);

            const { data: pA } = await supabase.from("daily_answers").select("answer")
              .eq("user_id", p.partner_id).eq("question_date", today).maybeSingle();
            if (cancelled) return;
            if (pA) setPartnerAnswer(pA.answer);

            const s = await calcStreak(user.id, p.partner_id);
            if (cancelled) return;
            setStreak(s);
          }
        }
      } catch (err) {
        if (cancelled) return;
        setLoadError(capture("DS-US-001", { component: "Us", action: "load", cause: err }));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [user, calcStreak, capture, reloadTick]);

  // Deep link: open the requested dialog once, after the hub has finished
  // its first load — then strip the param so a back/refresh doesn't reopen
  // it forever.
  useEffect(() => {
    if (loading || consumedFocusRef.current || !focus) return;
    consumedFocusRef.current = true;
    if (focus === "mood") setShowMoodDialog(true);
    if (focus === "countdown") setShowCountdownDialog(true);
    setSearchParams((prev) => { prev.delete("focus"); return prev; }, { replace: true });
  }, [focus, loading, setSearchParams]);

  // F1: Partner online presence via Supabase Presence
  useEffect(() => {
    if (!user || !partnerId) return;
    const channel = supabase.channel(`presence-${[user.id, partnerId].sort().join("-")}`, {
      config: { presence: { key: user.id } },
    });

    channel
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState();
        setPartnerOnline(!!state[partnerId]);
      })
      .on("presence", { event: "join" }, ({ key }) => { if (key === partnerId) setPartnerOnline(true); })
      .on("presence", { event: "leave" }, ({ key }) => { if (key === partnerId) setPartnerOnline(false); })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await channel.track({ online_at: new Date().toISOString() });
        }
      });

    return () => { supabase.removeChannel(channel); };
  }, [user, partnerId]);

  // F7: Listen for incoming taps
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel("incoming-taps")
      .on("postgres_changes", {
        event: "INSERT", schema: "public", table: "taps",
        filter: `receiver_id=eq.${user.id}`,
      }, () => {
        hapticNotification("success");
        toast({ title: "💫 Thinking of you!", description: "Your partner sent you a tap" });
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user, toast]);

  const updateMood = async () => {
    if (!user) return;
    const { error } = await supabase.from("profiles").update({
      mood_emoji: moodEmoji, mood_text: moodText, mood_updated_at: new Date().toISOString()
    }).eq("user_id", user.id);
    if (error) {
      capture("DS-MOOD-001", { component: "MoodDialog", action: "update", cause: error });
      toast({ title: "Mood didn't save", description: "Try again in a moment.", variant: "destructive" });
      return;
    }
    setProfile((p) => (p ? { ...p, mood_emoji: moodEmoji, mood_text: moodText } : p));
    setShowMoodDialog(false);
    hapticLight();
    toast({ title: "Mood updated ✨" });
  };

  // B4 Fix: sendTap includes receiver_id so receiver can filter taps for them
  const sendTap = async () => {
    if (!user || !partnerId) {
      toast({ title: "Link with a partner first", variant: "destructive" });
      return;
    }
    hapticMedium();
    const { error } = await supabase.from("taps").insert({ sender_id: user.id, receiver_id: partnerId } as any);
    if (error) {
      capture("DS-US-003", { component: "Us", action: "sendTap", cause: error });
      toast({ title: "Tap didn't send", description: "Try again.", variant: "destructive" });
      return;
    }
    toast({ title: "Sent! 💫", description: "They'll feel it" });
  };

  // B2 Fix: countdown creator_id set, filter applied on fetch
  const addCountdown = async () => {
    if (!user || !newCountdown.title || !newCountdown.date || savingCountdown) return;
    setSavingCountdown(true);
    hapticLight();
    const { data, error } = await supabase.from("countdowns").insert({
      creator_id: user.id,
      title: newCountdown.title,
      target_date: newCountdown.date,
      emoji: newCountdown.emoji,
    }).select().single();
    setSavingCountdown(false);
    if (error) {
      capture("DS-US-002", { component: "CountdownDialog", action: "insert", cause: error });
      toast({ title: "Couldn't save countdown", description: "Try adding it again.", variant: "destructive" });
      return;
    }
    if (data) setCountdowns((prev) => [...prev, data].sort((a, b) => new Date(a.target_date).getTime() - new Date(b.target_date).getTime()));
    setShowCountdownDialog(false);
    setNewCountdown({ title: "", date: "", emoji: "🎉" });
  };

  const deleteCountdown = async (id: string) => {
    const prev = countdowns;
    setCountdowns((cs) => cs.filter(c => c.id !== id)); // optimistic
    const { error } = await supabase.from("countdowns").delete().eq("id", id);
    if (error) {
      capture("DS-US-002", { component: "Us", action: "deleteCountdown", cause: error });
      setCountdowns(prev); // roll back
      toast({ title: "Couldn't delete countdown", variant: "destructive" });
    }
  };

  // B5 Fix: upsert instead of insert to prevent duplicates on double-tap
  const submitDailyAnswer = async () => {
    if (!user || !dailyAnswer.trim() || submittingAnswer) return;
    setSubmittingAnswer(true);
    hapticLight();
    const today = new Date().toISOString().split("T")[0];
    const { error } = await supabase.from("daily_answers").upsert(
      { user_id: user.id, question: todayQuestion, answer: dailyAnswer.trim(), question_date: today },
      { onConflict: "user_id,question_date" }
    );
    if (!error) {
      setMyAnswer(dailyAnswer.trim());
      setDailyAnswer("");
    } else {
      capture("DS-US-004", { component: "DailyQuestion", action: "submitAnswer", cause: error });
      toast({ title: "Answer didn't save", description: "Try submitting it again.", variant: "destructive" });
    }
    setSubmittingAnswer(false);
  };

  const daysUntil = (date: string) => {
    const diff = new Date(date).getTime() - Date.now();
    return Math.max(0, Math.ceil(diff / 86400000));
  };

  // B6 Fix: use safeTimeAgo
  const moodTimeStr = safeTimeAgo(partnerProfile?.mood_updated_at);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }} className="relative flex-1 min-h-0 overflow-y-auto overscroll-contain pb-24" style={{ WebkitOverflowScrolling: "touch" as any }}>
      <AmbientGlow />
      <PageHeader title="Us" subtitle="Our little world">
        <button onClick={() => navigate("/settings")} aria-label="Settings" className="h-9 w-9 rounded-xl bg-accent flex items-center justify-center">
          <Settings className="h-4 w-4 text-accent-foreground" aria-hidden="true" />
        </button>
      </PageHeader>

      {loadError ? (
        <div className="px-5 pt-6 flex justify-center">
          <ErrorCard error={loadError} onRetry={() => setReloadTick((t) => t + 1)} />
        </div>
      ) : loading ? (
        <div className="px-5 space-y-5" aria-busy="true" aria-label="Loading your world">
          <div className="bg-card rounded-2xl border border-border p-5 shadow-sm flex items-center gap-4">
            <Shimmer className="h-14 w-14 rounded-full shrink-0" />
            <div className="flex-1 space-y-2">
              <Shimmer className="h-3.5 w-28" />
              <Shimmer className="h-3 w-40" />
            </div>
            <Shimmer className="h-8 w-8 rounded-full shrink-0" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Shimmer className="h-24 rounded-2xl" />
            <Shimmer className="h-24 rounded-2xl" />
          </div>
          <Shimmer className="h-20 rounded-xl" />
          <Shimmer className="h-32 rounded-2xl" />
        </div>
      ) : (
      <div className="px-5 space-y-5">
        {/* Partner mood + streak + F1 online indicator */}
        <div className="glass-sheet rounded-panel p-5">
          <div className="flex items-center gap-4">
            <div className="relative">
              <button onClick={() => setShowMoodDialog(true)} aria-label="Change your mood"
                className="h-14 w-14 rounded-full bg-sand/50 flex items-center justify-center text-2xl shrink-0">
                {partnerProfile?.mood_emoji || "😊"}
              </button>
              {/* F1: Online dot */}
              <div className={`absolute bottom-0.5 right-0.5 h-3.5 w-3.5 rounded-full border-2 border-card ${partnerOnline ? "bg-success" : "bg-muted-foreground/30"}`} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="text-sm font-medium">{profile?.pet_name || partnerProfile?.display_name || "Partner"}</p>
                {partnerOnline && <span className="text-[10px] text-success font-medium">● Online</span>}
              </div>
              <p className="text-xs text-muted-foreground truncate">
                {partnerProfile?.mood_text || "No mood set"}
                {moodTimeStr && ` • ${moodTimeStr}`}
              </p>
            </div>
            <div className="text-center shrink-0">
              <p className="text-2xl font-serif">{streak}</p>
              <p className="text-[10px] text-muted-foreground">day streak 🔥</p>
            </div>
          </div>
        </div>

        {/* Quick actions */}
        <div className="grid grid-cols-2 gap-3">
          <motion.button whileTap={{ scale: 0.95 }} onClick={() => setShowMoodDialog(true)}
            className="glass-sheet rounded-2xl p-4 text-left">
            <div className="h-10 w-10 rounded-xl bg-accent flex items-center justify-center mb-3">
              <Smile className="h-5 w-5 text-accent-foreground" />
            </div>
            <p className="text-sm font-medium">My Mood</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">{profile?.mood_emoji} {profile?.mood_text || "Set mood"}</p>
          </motion.button>

          <motion.button whileTap={{ scale: 0.95 }} onClick={() => { setShowMoodHistory(true); }}
            className="bg-card rounded-2xl border border-border p-4 text-left shadow-sm">
            <div className="h-10 w-10 rounded-xl bg-sand/50 flex items-center justify-center mb-3">
              <TrendingUp className="h-5 w-5 text-foreground" />
            </div>
            <p className="text-sm font-medium">Mood History</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">Trends & check-ins</p>
          </motion.button>

          <motion.button whileTap={{ scale: 0.95 }} onClick={sendTap}
            className="glass-sheet rounded-2xl p-4 text-left">
            <div className="h-10 w-10 rounded-xl bg-sand/50 flex items-center justify-center mb-3">
              <Zap className="h-5 w-5 text-foreground" />
            </div>
            <p className="text-sm font-medium">Thinking of You</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Send a gentle tap to {(() => { const p = getPronouns(partnerProfile?.gender as Gender); return p.object; })()} 💫
            </p>
          </motion.button>
        </div>

        {/* Nickname reveal — the one place partnerProfile.pet_name (the
            name MY partner privately chose for ME) is shown at all, and
            only once tapped open. Everywhere else in the app, "partner's
            name" reads MY OWN pet_name (what I call them), not theirs. */}
        <button
          onClick={() => { setPetNameRevealed(v => !v); }}
          aria-expanded={petNameRevealed}
          className="w-full glass-sheet rounded-2xl p-4 text-left flex items-center gap-3"
        >
          <div className="h-10 w-10 rounded-xl bg-accent flex items-center justify-center shrink-0">
            {petNameRevealed ? <Eye className="h-5 w-5 text-accent-foreground" /> : <Tag className="h-5 w-5 text-accent-foreground" />}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">What they call you</p>
            <AnimatePresence mode="wait" initial={false}>
              {petNameRevealed ? (
                <motion.p key="revealed" initial={{ opacity: 0, y: -2 }} animate={{ opacity: 1, y: 0 }}
                  className="text-[11px] text-muted-foreground mt-0.5">
                  {partnerProfile?.pet_name
                    ? `${partnerProfile.display_name || "Your partner"} calls you "${partnerProfile.pet_name}"`
                    : `${partnerProfile?.display_name || "Your partner"} hasn't given you a nickname yet`}
                </motion.p>
              ) : (
                <motion.p key="hidden" initial={{ opacity: 0, y: -2 }} animate={{ opacity: 1, y: 0 }}
                  className="text-[11px] text-muted-foreground mt-0.5">Tap to reveal</motion.p>
              )}
            </AnimatePresence>
          </div>
        </button>

        {/* Countdowns */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Countdowns</h2>
            <button onClick={() => setShowCountdownDialog(true)} aria-label="Add countdown" className="h-9 w-9 rounded-lg bg-accent flex items-center justify-center">
              <Plus className="h-4 w-4 text-accent-foreground" aria-hidden="true" />
            </button>
          </div>

          {/* F6: Anniversary card — shown when set in Settings */}
          {appSettings.anniversaryDate && (() => {
            const ann = new Date(appSettings.anniversaryDate);
            const today = new Date();
            const nextAnn = new Date(ann);
            nextAnn.setFullYear(today.getFullYear());
            if (nextAnn < today) nextAnn.setFullYear(today.getFullYear() + 1);
            const days = Math.ceil((nextAnn.getTime() - today.getTime()) / 86400000);
            const yearsTogether = today.getFullYear() - ann.getFullYear() + (nextAnn.getFullYear() > today.getFullYear() ? 0 : 1);
            const isToday = days === 0 || days === 365;
            return (
              <motion.div
                animate={isToday ? { scale: [1, 1.02, 1] } : {}}
                transition={{ repeat: isToday ? Infinity : 0, duration: 2 }}
                className={`rounded-xl border p-3 flex items-center gap-3 mb-2 ${
                  isToday
                    ? "bg-primary/10 border-primary/30"
                    : "bg-card border-border"
                }`}
              >
                <span className="text-xl">💍</span>
                <div className="flex-1">
                  <p className="text-sm font-medium">{isToday ? "🎉 Happy Anniversary!" : "Our Anniversary"}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {ann.toLocaleDateString(undefined, { month: "long", day: "numeric" })} · Year {yearsTogether}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-lg font-serif text-primary">{isToday ? "🎉" : days}</p>
                  <p className="text-[10px] text-muted-foreground">{isToday ? "today!" : "days"}</p>
                </div>
              </motion.div>
            );
          })()}

          {countdowns.length === 0 && !appSettings.anniversaryDate ? (
            <p className="text-xs text-muted-foreground">No countdowns yet. Add one!</p>
          ) : (
            <div className="space-y-2">
              {countdowns.map((cd) => (
                <div key={cd.id} className="glass-sheet rounded-2xl p-3 flex items-center gap-3 group">
                  <span className="text-xl">{cd.emoji}</span>
                  <div className="flex-1">
                    <p className="text-sm font-medium">{cd.title}</p>
                    <p className="text-[11px] text-muted-foreground">{new Date(cd.target_date).toLocaleDateString()}</p>
                  </div>
                  <div className="text-right flex items-center gap-2">
                    <div>
                      <p className="text-lg font-serif">{daysUntil(cd.target_date)}</p>
                      <p className="text-[10px] text-muted-foreground">days</p>
                    </div>
                    {cd.creator_id === user?.id && (
                      // AUDIT FIX (Phase 7, Us/Profile): was
                      // `opacity-0 group-hover:opacity-100` with no touch
                      // fallback — on a touch device (this app's primary
                      // platform) there is no hover state, so this button
                      // was permanently invisible and undeletable for
                      // mobile users. No swipe/long-press alternative
                      // exists for this row either (checked), unlike
                      // MessageBubble's hover-only Reply button, which is
                      // fine left as-is because swipe-to-reply and the
                      // long-press context menu both already reach the
                      // same action on touch. Fixed using the same pattern
                      // CallHistoryRow.tsx already established for exactly
                      // this problem: dim-but-tappable on mobile, hover-to-
                      // fully-reveal only once a real hover state exists
                      // (`md:` breakpoint).
                      <button onClick={() => { hapticWarning(); setConfirmDeleteCountdown({ id: cd.id, title: cd.title }); }} aria-label="Delete countdown"
                        className="h-9 w-9 rounded-full flex items-center justify-center text-muted-foreground opacity-40 md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100 transition-opacity hover:text-destructive">
                        <X className="h-4 w-4" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Daily question */}
        <section>
          <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">Today's Question</h2>
          <div className="glass-sheet rounded-[24px] p-4 space-y-3">
            <p className="text-sm font-medium font-serif">{todayQuestion}</p>
            {myAnswer ? (
              <div className="bg-primary/10 rounded-xl p-3">
                <p className="text-[11px] text-muted-foreground mb-1">You</p>
                <p className="text-sm">{myAnswer}</p>
              </div>
            ) : (
              <div className="flex gap-2">
                <Input value={dailyAnswer} onChange={(e) => setDailyAnswer(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submitDailyAnswer()}
                  placeholder="Your answer..." className="h-10 rounded-xl text-sm" />
                <Button onClick={submitDailyAnswer} disabled={submittingAnswer || !dailyAnswer.trim()}
                  size="icon" className="h-10 w-10 rounded-xl bg-primary shrink-0">
                  <Send className="h-4 w-4 text-primary-foreground" />
                </Button>
              </div>
            )}
            {partnerAnswer && (
              <div className="bg-sand/30 rounded-xl p-3">
                <p className="text-[11px] text-muted-foreground mb-1">{profile?.pet_name || partnerProfile?.display_name || "Partner"}</p>
                <p className="text-sm">{partnerAnswer}</p>
              </div>
            )}
            {/* F12: Show if partner hasn't answered yet */}
            {myAnswer && !partnerAnswer && (
              <p className="text-[11px] text-muted-foreground text-center">Waiting for {profile?.pet_name || partnerProfile?.display_name || "partner"}'s answer…</p>
            )}
          </div>
        </section>

        <MemoryWall partnerId={partnerId} focusMemoryId={focusMemoryId} />
      </div>
      )}

      {/* Mood dialog */}
      <Dialog open={showMoodDialog} onOpenChange={setShowMoodDialog}>
        <DialogContent className="rounded-2xl max-w-sm">
          <DialogHeader><DialogTitle>Set your mood</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="flex gap-2 flex-wrap">
              {["😊", "😍", "🥰", "😴", "😢", "🤗", "😤", "🥳", "😌", "🫠", "💪", "✨"].map((e) => (
                <button key={e} onClick={() => setMoodEmoji(e)}
                  className={`text-2xl p-2 rounded-xl transition-colors ${moodEmoji === e ? "bg-accent" : "hover:bg-muted"}`}>
                  {e}
                </button>
              ))}
            </div>
            <Input value={moodText} onChange={(e) => setMoodText(e.target.value)}
              placeholder="How are you feeling?" className="rounded-xl" />
          </div>
          <DialogFooter>
            <Button onClick={updateMood} className="rounded-xl bg-primary text-primary-foreground w-full">Save Mood</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Countdown dialog */}
      <Dialog open={showCountdownDialog} onOpenChange={setShowCountdownDialog}>
        <DialogContent className="rounded-2xl max-w-sm">
          <DialogHeader><DialogTitle>New Countdown</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Input value={newCountdown.title} onChange={(e) => setNewCountdown({ ...newCountdown, title: e.target.value })}
              placeholder="Event name" className="rounded-xl" />
            <Input type="date" value={newCountdown.date}
              onChange={(e) => setNewCountdown({ ...newCountdown, date: e.target.value })}
              className="rounded-xl" />
            <div className="flex gap-2">
              {["🎉", "❤️", "✈️", "🎂", "💍", "🏖️", "🎓", "🎁"].map((e) => (
                <button key={e} onClick={() => setNewCountdown({ ...newCountdown, emoji: e })}
                  className={`text-xl p-2 rounded-xl transition-colors ${newCountdown.emoji === e ? "bg-accent" : "hover:bg-muted"}`}>
                  {e}
                </button>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button onClick={addCountdown} disabled={!newCountdown.title || !newCountdown.date || savingCountdown}
              className="rounded-xl bg-primary text-primary-foreground w-full">
              {savingCountdown ? "Adding…" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Mood history dialog */}
      <MoodHistory open={showMoodHistory} onClose={() => setShowMoodHistory(false)} />

      {/* Delete countdown confirmation — unified destructive-action pattern */}
      <AlertDialog open={!!confirmDeleteCountdown} onOpenChange={(v) => !v && setConfirmDeleteCountdown(null)}>
        <AlertDialogContent className="rounded-2xl max-w-xs">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">Delete "{confirmDeleteCountdown?.title}"?</AlertDialogTitle>
            <AlertDialogDescription>This countdown will be removed for both of you. This can't be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-xl">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="rounded-xl bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                hapticError();
                if (confirmDeleteCountdown) deleteCountdown(confirmDeleteCountdown.id);
                setConfirmDeleteCountdown(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </motion.div>
  );
};

export default Us;

/**
 * Relationship Reflection — Phase 2A (Relationship Intelligence V1).
 *
 * Kept as ONE focused page with internal tabs, per the brief's §2/§21: no new
 * app shell, no generic AI chatbot screen, uses the existing PageHeader/
 * Tabs/Button/Switch design system exactly as every other Hub destination
 * does. Reached only from the sparkle Hub (see lib/duoHubItems.ts) — the
 * dock stays Chat/Calls only.
 *
 * Everything here is private by default. The only way anything leaves this
 * device is the explicit "Share with partner" action on an individual item,
 * which always shows a preview first (src/lib/relationship/sharing.ts).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  Compass, HandHeart, MessageCircleHeart, Sparkles, Users, ChevronRight, Loader2,
  Check, HelpCircle, X as XIcon, Share2, ShieldCheck, Trash2, ArrowRight,
} from "lucide-react";
import PageHeader from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { hapticLight, hapticNotification } from "@/lib/haptics";
import { hasConsent, grantConsent } from "@/lib/privacy/consent";
import { ConsentFeature } from "@/lib/privacy/consentFeatures";
import { describeProvenance } from "@/lib/ai/provenance";
import type { AIInsight } from "@/lib/ai/types";
import {
  ALL_VALUE_CATEGORIES, CATEGORY_LABEL, TYPE_LABEL, IMPORTANCE_LABEL, AnswerMode,
  REFLECTION_PROMPTS, REFLECTION_FIELD_KEYS,
  VALUE_QUESTIONS, questionsForCategory, optionLabel,
  loadValues, createValueAnswer, updateValueAnswer,
  loadExpectations, createExpectation, setExpectationStatus, deleteExpectation,
  saveReflection, setCategorySkipped,
  listRelationshipInsights,
  correctInsight,
  previewValueAnswer, previewExpectation, previewInsight, withHash, confirmShare, revokeShare,
  listSharedByMe, getPartnerId,
  buildProductionRelationshipDeps,
  RelationshipError,
  type ValueCategory, type ValueAnswer, type Expectation, type ExpectationType, type Importance,
  type ReflectionFields, type ShareRow, type SharePreview,
} from "@/lib/relationship";
import { createRelationshipAIService } from "@/lib/relationship/service";

type Tab = "values" | "expectations" | "reflect" | "insights";

const CATEGORY_ORDER: ValueCategory[] = [...ALL_VALUE_CATEGORIES];

/** Races a promise against a timeout so a hung network/storage call can't
 * leave the page stuck on its loading spinner forever. Rejects on timeout;
 * callers decide how to degrade (see the loading effect below). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

const Reflection = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>("values");
  const [ready, setReady] = useState(false);
  const [consentGranted, setConsentGranted] = useState(false);
  const [grantingConsent, setGrantingConsent] = useState(false);

  const deps = useMemo(() => buildProductionRelationshipDeps(), []);
  const storeCtx = useMemo(() => ({ backend: deps.backend, now: deps.now, newId: deps.newId }), [deps]);

  const [answers, setAnswers] = useState<ValueAnswer[]>([]);
  const [skipped, setSkipped] = useState<ValueCategory[]>([]);
  const [expectations, setExpectations] = useState<Expectation[]>([]);
  const [insights, setInsights] = useState<AIInsight[]>([]);
  const [sharedByMe, setSharedByMe] = useState<ShareRow[]>([]);
  const [partnerId, setPartnerId] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  const refreshLocal = useCallback(async () => {
    if (!user) return;
    // Values/expectations/insights all live in on-device secure storage
    // (secureStorage.ts) — no network round trip. Every plain edit (answer
    // a question, add/archive/delete an expectation, submit a reflection,
    // rate an insight) only needs THIS, not a full refresh().
    const [v, e, i] = await Promise.all([
      loadValues(user.id, storeCtx),
      loadExpectations(user.id, storeCtx),
      listRelationshipInsights(user.id, deps),
    ]);
    setAnswers(v.answers);
    setSkipped(v.skippedCategories);
    setExpectations(e);
    setInsights(i);
  }, [user, storeCtx, deps]);

  const refresh = useCallback(async () => {
    if (!user) return;
    // Full refresh: adds the two Supabase round trips (sharedByMe,
    // partnerId) on top of the local reload above. Reserved for the
    // initial page load and for actions that actually change sharing
    // state (confirming or revoking a share) — every other interaction
    // used to call this on every tap, which is what made the page feel
    // laggy: answering one values question was refetching shares and
    // the partner id from the network every single time.
    const [, s, p] = await Promise.all([
      refreshLocal(),
      listSharedByMe(user.id),
      getPartnerId(user.id),
    ]);
    setSharedByMe(s);
    setPartnerId(p);
  }, [user, storeCtx, deps, refreshLocal]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    // Defensive: if a previous visit already left document.body stuck at
    // pointer-events: none (the Radix unmount-while-open bug the tab-panes
    // fix above prevents going forward), clear it on entry so this page
    // itself is usable even before the user reloads/backgrounds the app.
    if (document.body.style.pointerEvents === "none") {
      document.body.style.pointerEvents = "";
    }
    (async () => {
      try {
        const granted = await withTimeout(hasConsent(user.id, ConsentFeature.RELATIONSHIP_INSIGHTS), 8000);
        if (cancelled) return;
        setConsentGranted(granted);
        if (granted) await withTimeout(refresh(), 8000);
      } catch {
        // A slow/failed load must not leave the page stuck on the spinner
        // forever — fall through and render with whatever we have (empty
        // state), same as a real "nothing yet" first run.
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const grantAndEnter = async () => {
    if (!user) return;
    setGrantingConsent(true);
    try {
      await grantConsent(user.id, ConsentFeature.RELATIONSHIP_INSIGHTS, "reflection_onboarding");
      setConsentGranted(true);
      await refresh();
    } catch {
      toast({ title: "Couldn't turn this on", description: "Try again in a moment.", variant: "destructive" });
    } finally {
      setGrantingConsent(false);
    }
  };

  if (!ready) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center bg-background">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!consentGranted) {
    return (
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex-1 min-h-0 overflow-y-auto bg-background">
        <PageHeader title="Relationship Reflection" />
        <div className="px-5 pt-6 pb-24 space-y-5">
          <div className="rounded-2xl bg-accent/10 border border-accent/20 p-5 space-y-3">
            <Compass className="h-6 w-6 text-accent" />
            <p className="text-sm text-foreground leading-relaxed">
              This is a private reflection space. DuoSpace does not know what your partner is thinking.
              Insights are based only on information you choose to provide.
            </p>
            <p className="text-[12px] text-muted-foreground leading-relaxed">
              Everything you write stays on this device unless you explicitly choose to share one specific
              item — you'll always see exactly what will be shared before it sends. Nothing is ever scored,
              ranked, or compared against your partner as "better" or "worse".
            </p>
          </div>
          <Button className="w-full" onClick={grantAndEnter} disabled={grantingConsent}>
            {grantingConsent ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Turn on Relationship Reflection
          </Button>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex-1 min-h-0 flex flex-col bg-background">
      <PageHeader title="Relationship Reflection" subtitle="Private — only you can see this unless you choose to share" />
      <div className="px-4 pt-3">
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList className="w-full grid grid-cols-4">
            <TabsTrigger value="values" className="text-[11px]">Values</TabsTrigger>
            <TabsTrigger value="expectations" className="text-[11px]">Expectations</TabsTrigger>
            <TabsTrigger value="reflect" className="text-[11px]">Reflect</TabsTrigger>
            <TabsTrigger value="insights" className="text-[11px]">Insights</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {/* BUG FIX (app-wide "nothing is clickable" + everything laggy after
          visiting Reflection): this used to be `{tab === "x" && <XTab/>}` —
          a real conditional MOUNT, so switching tabs while a Dialog inside
          the outgoing tab was open (share-preview, boundary-confirm,
          rate-insight) yanked that Dialog out of the tree before Radix's
          own onOpenChange(false)/close cleanup ran. Radix's Dialog toggles
          `document.body.style.pointerEvents = "none"` while open and
          normally restores it on close — but an unmount-while-open skips
          that restore, so the WHOLE app (not just this page) is left
          permanently unclickable, and it doesn't self-heal because a tab
          switch is client-side routing, not a real document reload.
          Fix: keep all four tabs mounted (cheap — they only read props,
          no fetch-on-mount) and just hide the inactive ones, same
          don't-unmount-to-dodge-teardown-bugs approach ChatCallsShell
          already uses for Chat/Calls. */}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 py-4 pb-24 space-y-4">
        <div className={tab === "values" ? undefined : "hidden"}>
          <ValuesTab
            userId={user!.id} storeCtx={storeCtx} deps={deps}
            answers={answers} skipped={skipped} partnerId={partnerId}
            analyzing={analyzing} setAnalyzing={setAnalyzing}
            onChanged={refreshLocal} toast={toast}
          />
        </div>
        <div className={tab === "expectations" ? undefined : "hidden"}>
          <ExpectationsTab
            userId={user!.id} storeCtx={storeCtx} deps={deps}
            items={expectations} partnerId={partnerId}
            analyzing={analyzing} setAnalyzing={setAnalyzing}
            onChanged={refreshLocal} toast={toast}
          />
        </div>
        <div className={tab === "reflect" ? undefined : "hidden"}>
          <ReflectTab userId={user!.id} storeCtx={storeCtx} deps={deps} analyzing={analyzing} setAnalyzing={setAnalyzing} onChanged={refreshLocal} toast={toast} />
        </div>
        <div className={tab === "insights" ? undefined : "hidden"}>
          <InsightsTab
            userId={user!.id} storeCtx={storeCtx} insights={insights} sharedByMe={sharedByMe} partnerId={partnerId}
            onChanged={refreshLocal} onSharesChanged={refresh} toast={toast}
          />
        </div>
      </div>
    </motion.div>
  );
};

// ── shared bits ──────────────────────────────────────────────────────────

type ToastFn = ReturnType<typeof useToast>["toast"];

function friendlyError(err: unknown): string {
  if (err instanceof RelationshipError) return err.message;
  return "Something went wrong. Nothing was saved or sent.";
}

const EvidenceLine = ({ insight }: { insight: AIInsight }) => {
  const prov = describeProvenance(insight.source);
  return <p className="text-[10px] text-muted-foreground/70 italic">{prov.label}</p>;
};

/** The "show exactly what will be shared" confirmation dialog — used by all three item types. */
const SharePreviewDialog = ({
  preview, onCancel, onConfirm, sharing,
}: { preview: SharePreview | null; onCancel: () => void; onConfirm: () => void; sharing: boolean }) => (
  <Dialog open={!!preview} onOpenChange={(o) => !o && onCancel()}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Share with your partner?</DialogTitle>
        <DialogDescription>This is exactly what they'll see — nothing more.</DialogDescription>
      </DialogHeader>
      <div className="space-y-2 py-2">
        {preview?.lines.map((l) => (
          <div key={l.label} className="rounded-lg bg-muted/50 px-3 py-2">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{l.label}</p>
            <p className="text-sm text-foreground">{l.value}</p>
          </div>
        ))}
      </div>
      <DialogFooter className="gap-2">
        <Button variant="outline" onClick={onCancel} disabled={sharing}>Cancel</Button>
        <Button onClick={onConfirm} disabled={sharing}>
          {sharing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Share2 className="h-4 w-4 mr-2" />}
          Share this
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

// ── Values ───────────────────────────────────────────────────────────────

function ValuesTab({ userId, storeCtx, deps, answers, skipped, partnerId, analyzing, setAnalyzing, onChanged, toast }: any) {
  const [category, setCategory] = useState<ValueCategory>(CATEGORY_ORDER[0]);
  const [preview, setPreview] = useState<SharePreview | null>(null);
  const [sharing, setSharing] = useState(false);

  const byQuestion = useMemo(() => new Map(answers.map((a: ValueAnswer) => [a.questionId, a])), [answers]);
  const questions = questionsForCategory(category);
  const isSkipped = skipped.includes(category);

  const answer = async (questionId: string, mode: "ANSWERED" | "NOT_SURE" | "PREFER_NOT_TO_ANSWER", choiceId?: string) => {
    hapticLight();
    try {
      const existing = byQuestion.get(questionId);
      const input = { questionId, mode: mode as AnswerMode, choiceId: choiceId ?? null };
      if (existing) await updateValueAnswer(userId, input, storeCtx);
      else await createValueAnswer(userId, input, storeCtx);
      await onChanged();
    } catch (err) {
      toast({ title: "Couldn't save", description: friendlyError(err), variant: "destructive" });
    }
  };

  const runAnalysis = async () => {
    setAnalyzing(true);
    try {
      const record = { version: 1 as const, answers, skippedCategories: skipped };
      const res = await createRelationshipAIService({ deps }).analyzeValues(userId, record);
      hapticNotification();
      toast({ title: res.saved.length ? "New reflection ready" : "Nothing new yet", description: res.saved.length ? `Check the Insights tab. ${res.label}.` : "Answer a few more questions first." });
      await onChanged();
    } catch (err) {
      toast({ title: "Couldn't reflect on this yet", description: friendlyError(err), variant: "destructive" });
    } finally {
      setAnalyzing(false);
    }
  };

  const openShare = (a: ValueAnswer, prompt: string) => {
    const p = previewValueAnswer(a, prompt);
    withHash(p).then(setPreview);
  };
  const confirm = async () => {
    if (!preview) return;
    setSharing(true);
    try {
      await confirmShare(userId, preview, { gate: deps.gate, store: storeCtx });
      hapticNotification();
      toast({ title: "Shared" });
      setPreview(null);
      await onChanged();
    } catch (err) {
      toast({ title: "Couldn't share", description: friendlyError(err), variant: "destructive" });
    } finally {
      setSharing(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
        {CATEGORY_ORDER.map((c) => (
          <button
            key={c}
            onClick={() => setCategory(c)}
            className={`shrink-0 rounded-full px-3 py-1.5 text-[11px] font-medium border ${category === c ? "bg-accent text-accent-foreground border-accent" : "bg-card text-muted-foreground border-border/60"}`}
          >
            {CATEGORY_LABEL[c]}
          </button>
        ))}
      </div>

      <label className="flex items-center justify-between rounded-xl border border-border/50 px-3 py-2.5">
        <span className="text-[12px] text-muted-foreground">This doesn't apply to my relationship</span>
        <Switch checked={isSkipped} onCheckedChange={(v) => {
          setCategorySkipped(userId, category, v, storeCtx).then(onChanged).catch((err) => {
            toast({ title: "Couldn't save", description: friendlyError(err), variant: "destructive" });
          });
        }} />
      </label>

      {!isSkipped && questions.map((q) => {
        const a = byQuestion.get(q.id) as ValueAnswer | undefined;
        return (
          <div key={q.id} className="rounded-2xl bg-card border border-border/60 p-4 space-y-2.5">
            <p className="text-sm font-medium text-foreground">{q.prompt}</p>
            <div className="flex flex-wrap gap-2">
              {q.options.map((o) => (
                <button
                  key={o.id}
                  onClick={() => answer(q.id, "ANSWERED", o.id)}
                  className={`rounded-full px-3 py-1.5 text-[12px] border ${a?.mode === "ANSWERED" && a.choiceId === o.id ? "bg-primary text-primary-foreground border-primary" : "bg-muted/50 border-border/50 text-foreground"}`}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3 pt-1">
              <button onClick={() => answer(q.id, "NOT_SURE")} className={`flex items-center gap-1 text-[11px] ${a?.mode === "NOT_SURE" ? "text-accent" : "text-muted-foreground"}`}>
                <HelpCircle className="h-3.5 w-3.5" /> Not sure
              </button>
              <button onClick={() => answer(q.id, "PREFER_NOT_TO_ANSWER")} className={`flex items-center gap-1 text-[11px] ${a?.mode === "PREFER_NOT_TO_ANSWER" ? "text-accent" : "text-muted-foreground"}`}>
                <XIcon className="h-3.5 w-3.5" /> Prefer not to answer
              </button>
              {a?.mode === "ANSWERED" && partnerId && (
                <button onClick={() => openShare(a, q.prompt)} className="flex items-center gap-1 text-[11px] text-muted-foreground ml-auto">
                  <Share2 className="h-3.5 w-3.5" /> {a.visibility === "SHARED_WITH_PARTNER" ? "Shared" : "Share"}
                </button>
              )}
            </div>
          </div>
        );
      })}

      <Button variant="secondary" className="w-full" onClick={runAnalysis} disabled={analyzing || answers.length === 0}>
        {analyzing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Sparkles className="h-4 w-4 mr-2" />}
        Reflect on my answers
      </Button>
      <SharePreviewDialog preview={preview} onCancel={() => setPreview(null)} onConfirm={confirm} sharing={sharing} />
    </div>
  );
}

// ── Expectations ─────────────────────────────────────────────────────────

const EXPECTATION_TYPES: ExpectationType[] = ["PREFERENCE", "EXPECTATION", "BOUNDARY"];
const IMPORTANCE_LEVELS: Importance[] = ["LOW", "MEDIUM", "HIGH"];

function ExpectationsTab({ userId, storeCtx, deps, items, partnerId, analyzing, setAnalyzing, onChanged, toast }: any) {
  const [statement, setStatement] = useState("");
  const [category, setCategory] = useState<ValueCategory>(CATEGORY_ORDER[0]);
  const [type, setType] = useState<ExpectationType>("PREFERENCE");
  const [importance, setImportance] = useState<Importance>("MEDIUM");
  const [confirmBoundaryOpen, setConfirmBoundaryOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<SharePreview | null>(null);
  const [sharing, setSharing] = useState(false);

  const doCreate = async (confirmedBoundary?: boolean) => {
    if (statement.trim().length < 3) return;
    setSaving(true);
    try {
      await createExpectation(userId, { category, statement, type, importance, confirmedBoundary }, storeCtx);
      setStatement("");
      hapticLight();
      await onChanged();
    } catch (err) {
      if (err instanceof RelationshipError && err.code === "BOUNDARY_NOT_CONFIRMED") {
        setConfirmBoundaryOpen(true);
      } else {
        toast({ title: "Couldn't save", description: friendlyError(err), variant: "destructive" });
      }
    } finally {
      setSaving(false);
    }
  };

  const archive = async (id: string) => {
    try {
      await setExpectationStatus(userId, id, "ARCHIVED", storeCtx);
      await onChanged();
    } catch (err) {
      toast({ title: "Couldn't update", description: friendlyError(err), variant: "destructive" });
    }
  };
  const remove = async (id: string) => {
    try {
      await deleteExpectation(userId, id, storeCtx);
      await onChanged();
    } catch (err) {
      toast({ title: "Couldn't delete", description: friendlyError(err), variant: "destructive" });
    }
  };

  const runAnalysis = async () => {
    setAnalyzing(true);
    try {
      const res = await createRelationshipAIService({ deps }).analyzeExpectations(userId, items);
      hapticNotification();
      toast({ title: res.saved.length ? "New reflection ready" : "Nothing new yet", description: res.saved.length ? "Check the Insights tab." : "Add a few items first." });
      await onChanged();
    } catch (err) {
      toast({ title: "Couldn't reflect on this yet", description: friendlyError(err), variant: "destructive" });
    } finally {
      setAnalyzing(false);
    }
  };

  const openShare = (item: Expectation) => withHash(previewExpectation(item)).then(setPreview);
  const confirm = async () => {
    if (!preview) return;
    setSharing(true);
    try {
      await confirmShare(userId, preview, { gate: deps.gate, store: storeCtx });
      hapticNotification();
      toast({ title: "Shared" });
      setPreview(null);
      await onChanged();
    } catch (err) {
      toast({ title: "Couldn't share", description: friendlyError(err), variant: "destructive" });
    } finally {
      setSharing(false);
    }
  };

  const active = (items as Expectation[]).filter((e) => e.status === "ACTIVE");

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-card border border-border/60 p-4 space-y-3">
        <p className="text-sm font-medium">Add something you'd like to name</p>
        <select value={category} onChange={(e) => setCategory(e.target.value as ValueCategory)} className="w-full rounded-lg border border-border/50 bg-muted/40 px-3 py-2 text-sm">
          {CATEGORY_ORDER.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
        </select>
        <Textarea value={statement} onChange={(e) => setStatement(e.target.value)} placeholder="Describe it in your own words…" rows={2} maxLength={280} />
        <div className="flex gap-2">
          {EXPECTATION_TYPES.map((t) => (
            <button key={t} onClick={() => setType(t)} className={`flex-1 rounded-lg px-2 py-2 text-[11px] font-medium border ${type === t ? "bg-accent text-accent-foreground border-accent" : "bg-muted/40 border-border/50 text-foreground"}`}>
              {TYPE_LABEL[t]}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          {IMPORTANCE_LEVELS.map((i) => (
            <button key={i} onClick={() => setImportance(i)} className={`flex-1 rounded-lg px-2 py-1.5 text-[11px] border ${importance === i ? "bg-primary/15 border-primary text-primary" : "bg-muted/30 border-border/40 text-muted-foreground"}`}>
              {IMPORTANCE_LABEL[i]}
            </button>
          ))}
        </div>
        <Button className="w-full" onClick={() => doCreate()} disabled={saving || statement.trim().length < 3}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
          Add
        </Button>
      </div>

      <div className="space-y-2">
        {active.map((item) => (
          <div key={item.id} className="rounded-xl bg-card border border-border/50 p-3.5 space-y-1.5">
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span>{CATEGORY_LABEL[item.category]}</span><span>·</span><span className="font-medium">{TYPE_LABEL[item.type]}</span><span>·</span><span>{IMPORTANCE_LABEL[item.importance]}</span>
            </div>
            <p className="text-sm text-foreground">{item.statement}</p>
            <div className="flex items-center gap-3 pt-1">
              {partnerId && (
                <button onClick={() => openShare(item)} className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Share2 className="h-3.5 w-3.5" /> {item.visibility === "SHARED_WITH_PARTNER" ? "Shared" : "Share"}
                </button>
              )}
              <button onClick={() => archive(item.id)} className="text-[11px] text-muted-foreground ml-auto">Not relevant anymore</button>
              <button onClick={() => remove(item.id)} className="text-[11px] text-destructive flex items-center gap-1"><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          </div>
        ))}
        {active.length === 0 && <p className="text-[12px] text-muted-foreground text-center py-4">Nothing added yet.</p>}
      </div>

      <Button variant="secondary" className="w-full" onClick={runAnalysis} disabled={analyzing || active.length === 0}>
        {analyzing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Sparkles className="h-4 w-4 mr-2" />}
        Reflect on these
      </Button>

      <Dialog open={confirmBoundaryOpen} onOpenChange={setConfirmBoundaryOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark this as a boundary?</DialogTitle>
            <DialogDescription>A boundary is something you consider necessary — not just a preference. Only you can decide this.</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setConfirmBoundaryOpen(false)}>Cancel</Button>
            <Button onClick={() => { setConfirmBoundaryOpen(false); doCreate(true); }}>Yes, this is a boundary</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <SharePreviewDialog preview={preview} onCancel={() => setPreview(null)} onConfirm={confirm} sharing={sharing} />
    </div>
  );
}

// ── Communication reflection ─────────────────────────────────────────────

function ReflectTab({ userId, storeCtx, deps, analyzing, setAnalyzing, onChanged, toast }: any) {
  const [fields, setFields] = useState<Partial<ReflectionFields>>({});
  const [keepOnDevice, setKeepOnDevice] = useState(false);
  const [saving, setSaving] = useState(false);

  const set = (key: keyof ReflectionFields, value: string) => setFields((f) => ({ ...f, [key]: value }));
  const hasAny = REFLECTION_FIELD_KEYS.some((k) => (fields[k] ?? "").trim().length > 0);

  const submit = async () => {
    if (!hasAny) return;
    setSaving(true);
    try {
      if (keepOnDevice) await saveReflection(userId, fields, storeCtx);
      const res = await createRelationshipAIService({ deps }).analyzeReflection(userId, fields);
      hapticNotification();
      toast({ title: res.saved.length ? "New reflection ready" : "Nothing to reflect on yet", description: res.saved.length ? `Check the Insights tab. ${res.label}.` : undefined });
      setFields({});
      setKeepOnDevice(false);
      await onChanged();
    } catch (err) {
      toast({ title: "Couldn't process this", description: friendlyError(err), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {REFLECTION_FIELD_KEYS.map((key) => (
        <div key={key} className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">{REFLECTION_PROMPTS[key]}</p>
          <Textarea value={fields[key] ?? ""} onChange={(e) => set(key, e.target.value)} rows={3} maxLength={2000} placeholder="Write as much or as little as you'd like…" />
        </div>
      ))}
      <label className="flex items-center justify-between rounded-xl border border-border/50 px-3 py-2.5">
        <span className="text-[12px] text-muted-foreground">Keep what I wrote on this device</span>
        <Switch checked={keepOnDevice} onCheckedChange={setKeepOnDevice} />
      </label>
      <Button className="w-full" onClick={submit} disabled={saving || !hasAny}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <MessageCircleHeart className="h-4 w-4 mr-2" />}
        Reflect on this
      </Button>
      <p className="text-[11px] text-muted-foreground leading-relaxed">
        This only analyzes what you write here. Your partner is never analyzed, and nothing about what "really"
        happened between you is asserted — only what you reported.
      </p>
    </div>
  );
}

// ── Insights ─────────────────────────────────────────────────────────────

function InsightsTab({ userId, storeCtx, insights, sharedByMe, partnerId, onChanged, onSharesChanged, toast }: any) {
  const [preview, setPreview] = useState<SharePreview | null>(null);
  const [sharing, setSharing] = useState(false);
  const [correcting, setCorrecting] = useState<AIInsight | null>(null);

  const deps = useMemo(() => buildProductionRelationshipDeps(), []);

  const openShare = (insight: AIInsight) => withHash(previewInsight(insight)).then(setPreview);
  const confirm = async (insight: AIInsight) => {
    if (!preview) return;
    setSharing(true);
    try {
      await confirmShare(userId, preview, { gate: deps.gate, store: storeCtx });
      hapticNotification();
      toast({ title: "Shared" });
      setPreview(null);
      await onSharesChanged();
    } catch (err) {
      toast({ title: "Couldn't share", description: friendlyError(err), variant: "destructive" });
    } finally {
      setSharing(false);
    }
  };

  const doCorrect = async (verdict: "CORRECT" | "PARTLY_ACCURATE" | "NOT_ACCURATE" | "NOT_RELEVANT") => {
    if (!correcting) return;
    try {
      await correctInsight(userId, { insightId: correcting.id, verdict }, { backend: deps.backend, now: deps.now });
      setCorrecting(null);
      await onChanged();
    } catch (err) {
      toast({ title: "Couldn't save your feedback", description: friendlyError(err), variant: "destructive" });
    }
  };

  const revoke = async (shareId: string) => {
    try {
      await revokeShare(userId, shareId, { store: storeCtx });
      toast({ title: "Sharing stopped" });
      await onSharesChanged();
    } catch (err) {
      toast({ title: "Couldn't stop sharing", description: friendlyError(err), variant: "destructive" });
    }
  };

  return (
    <div className="space-y-4">
      {insights.length === 0 && (
        <p className="text-[12px] text-muted-foreground text-center py-6">
          Nothing yet. Answer some questions in Values or Expectations, or write a reflection, then tap "Reflect".
        </p>
      )}
      {insights.map((insight: AIInsight) => (
        <div key={insight.id} className="rounded-2xl bg-card border border-border/60 p-4 space-y-2">
          <EvidenceLine insight={insight} />
          <p className="text-sm text-foreground leading-relaxed">{insight.observation}</p>
          {insight.possibleExplanations.length > 0 && (
            <ul className="space-y-1">
              {insight.possibleExplanations.map((e, idx) => (
                <li key={idx} className="text-[12px] text-muted-foreground flex gap-1.5"><ArrowRight className="h-3 w-3 mt-0.5 shrink-0" />{e}</li>
              ))}
            </ul>
          )}
          <p className="text-[11px] text-muted-foreground/80 italic">{insight.uncertainty}</p>
          {insight.suggestedAction && <p className="text-[12px] text-foreground/80">{insight.suggestedAction}</p>}
          {insight.evidence && insight.evidence.length > 0 && (
            <p className="text-[10px] text-muted-foreground/60">Based on: {insight.evidence.join("; ")}</p>
          )}
          {insight.correction && (
            <p className="text-[10px] text-accent flex items-center gap-1"><Check className="h-3 w-3" /> You marked this {insight.correction.verdict.toLowerCase().replace("_", " ")}</p>
          )}
          <div className="flex items-center gap-3 pt-1">
            <button onClick={() => setCorrecting(insight)} className="text-[11px] text-muted-foreground">Rate this</button>
            {partnerId && (
              <button onClick={() => openShare(insight)} className="flex items-center gap-1 text-[11px] text-muted-foreground ml-auto">
                <Share2 className="h-3.5 w-3.5" /> Share
              </button>
            )}
          </div>
        </div>
      ))}

      {sharedByMe.filter((s: ShareRow) => !s.revokedAt).length > 0 && (
        <div className="pt-2 space-y-2">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground flex items-center gap-1.5"><Users className="h-3.5 w-3.5" /> Shared with your partner</p>
          {sharedByMe.filter((s: ShareRow) => !s.revokedAt).map((s: ShareRow) => (
            <div key={s.id} className="rounded-xl bg-muted/30 border border-border/40 px-3.5 py-2.5 flex items-center justify-between gap-2">
              <span className="text-[12px] text-foreground">{s.kind === "INSIGHT" ? "An insight" : s.kind === "EXPECTATION" ? "An expectation" : "A values answer"}</span>
              <button onClick={() => revoke(s.id)} className="text-[11px] text-destructive shrink-0">Stop sharing</button>
            </div>
          ))}
        </div>
      )}

      <SharePreviewDialog preview={preview} onCancel={() => setPreview(null)} onConfirm={() => confirm(preview as any)} sharing={sharing} />

      <Dialog open={!!correcting} onOpenChange={(o) => !o && setCorrecting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>How accurate was this?</DialogTitle>
            <DialogDescription>This only records your own feedback — nothing is retrained.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-2 py-2">
            <Button variant="outline" onClick={() => doCorrect("CORRECT")}>Accurate</Button>
            <Button variant="outline" onClick={() => doCorrect("PARTLY_ACCURATE")}>Partly accurate</Button>
            <Button variant="outline" onClick={() => doCorrect("NOT_ACCURATE")}>Not accurate</Button>
            <Button variant="outline" onClick={() => doCorrect("NOT_RELEVANT")}>Not relevant anymore</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default Reflection;

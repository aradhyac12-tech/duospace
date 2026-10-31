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
import { Compass, Loader2 } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { hasConsent, grantConsent } from "@/lib/privacy/consent";
import { ConsentFeature } from "@/lib/privacy/consentFeatures";
import type { AIInsight } from "@/lib/ai/types";
import { loadValues, loadExpectations, listRelationshipInsights, listSharedByMe, getPartnerId, buildProductionRelationshipDeps, type ValueCategory, type ValueAnswer, type Expectation, type ShareRow } from "@/lib/relationship";
import PartnerComparison from "@/components/relationship/PartnerComparison";
import { tr } from "@/lib/i18n";
import DailyCheckIn from "@/components/relationship/DailyCheckIn";
import AdaptiveQuestionCard from "@/components/relationship/AdaptiveQuestionCard";
import ValuesTab from "@/components/relationship/ValuesTab";
import ExpectationsTab from "@/components/relationship/ExpectationsTab";
import ReflectTab from "@/components/relationship/ReflectTab";
import InsightsTab from "@/components/relationship/InsightsTab";
import TodayInsight from "@/components/relationship/TodayInsight";
import type { RepairEntry } from "@/components/relationship/RepairPanel";
import { useLocation, useNavigate as useNav } from "react-router-dom";

type Tab = "values" | "expectations" | "reflect" | "insights";

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
  // Opens on "Today" (the everyday check-in); the questionnaires stay one tap away.
  const [tab, setTab] = useState<Tab>("insights");
  const [moreTools, setMoreTools] = useState(false);
  // "Understand" → "Need help repairing this?" arrives here with the partner's words; open More tools once, then clear router state.
  const routerLocation = useLocation();
  const nav = useNav();
  const [initialRepair, setInitialRepair] = useState<RepairEntry | null>(null);
  useEffect(() => {
    const r = (routerLocation.state as { repair?: RepairEntry } | null)?.repair;
    if (r && typeof r.partnerSaid === "string") {
      setTab("insights"); setMoreTools(true); setInitialRepair(r);
      nav(routerLocation.pathname, { replace: true, state: null });
    }
  }, [routerLocation.state, routerLocation.pathname, nav]);
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
      <PageHeader title={tr("p1.rel.title")} subtitle={tr("p1.rel.subtitle")} />
      <div className="px-4 pt-3">
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList className="w-full grid grid-cols-4">
            <TabsTrigger value="insights" className="text-[11px]">{tr("p1.today.title")}</TabsTrigger>
            <TabsTrigger value="values" className="text-[11px]">{tr("p1.rel.tab.values")}</TabsTrigger>
            <TabsTrigger value="expectations" className="text-[11px]">{tr("p1.rel.tab.expectations")}</TabsTrigger>
            <TabsTrigger value="reflect" className="text-[11px]">{tr("p1.rel.tab.reflect")}</TabsTrigger>
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
        <div className={tab === "insights" ? "space-y-4" : "hidden"}>
          <TodayInsight userId={user!.id} partnerId={partnerId} />
          <p className="text-[11px] text-muted-foreground px-1">{tr("p1.rel.chatHint")}</p>
          <button onClick={() => setMoreTools((o) => !o)} className="w-full rounded-xl border border-border/60 px-4 py-2.5 text-sm text-left flex justify-between items-center" aria-expanded={moreTools}>
            <span>{tr("p1.rel.moreTools")}</span><span className="text-xs text-muted-foreground">{moreTools ? tr("p1.rel.hide") : tr("p1.rel.moreToolsList")}</span>
          </button>
          {moreTools && (
            <>
              <DailyCheckIn userId={user!.id} onOpenRepair={() => setMoreTools(true)} />
              <AdaptiveQuestionCard userId={user!.id} answers={answers} storeCtx={storeCtx} onChanged={refreshLocal} toast={toast} />
              <PartnerComparison
                userId={user!.id} partnerId={partnerId} answers={answers} skipped={skipped}
                expectations={expectations} storeCtx={storeCtx} toast={toast} initialRepair={initialRepair}
              />
              <InsightsTab
                userId={user!.id} storeCtx={storeCtx} insights={insights} sharedByMe={sharedByMe} partnerId={partnerId}
                onChanged={refreshLocal} onSharesChanged={refresh} toast={toast}
              />
            </>
          )}
        </div>
      </div>
    </motion.div>
  );
};

// ── Values ───────────────────────────────────────────────────────────────

export default Reflection;

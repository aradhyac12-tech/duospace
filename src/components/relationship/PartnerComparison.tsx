/**
 * Phase 3A — the minimum UI surface for dyadic understanding: comparison,
 * evidence, unknowns, conversation prompt, corrections, and a reply helper.
 * No score, no status colours for the relationship, no ranking.
 */
import { useCallback, useState } from "react";
import { ChevronDown, ChevronUp, MessageCircleQuestion, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import ResponseSupportPanel from "./ResponseSupportPanel";
import RepairPanel, { type RepairEntry } from "./RepairPanel";
import MemoryPanel from "./MemoryPanel";
import CompatibilityOverview from "./CompatibilityOverview";
import { Textarea } from "@/components/ui/textarea";
import { createRelationshipAIService } from "@/lib/relationship/service";
import { buildProductionRelationshipDeps } from "@/lib/relationship/production";
import { listSharedWithMe, revokeShare } from "@/lib/relationship/sharing";
import {
  addCorrection, loadCorrections,
  type CorrectionKind, type DyadicResult, type DyadicView,
} from "@/lib/relationship/dyadic";
import type { Expectation, ValueAnswer, ValuesRecord, ValueCategory } from "@/lib/relationship/types";
import type { StoreCtx } from "@/lib/relationship/stores";

interface Props {
  userId: string;
  partnerId: string | null;
  answers: ValueAnswer[];
  skipped: ValueCategory[];
  expectations: Expectation[];
  storeCtx: StoreCtx;
  toast: (t: { title: string; description?: string; variant?: "destructive" }) => void;
  initialRepair?: RepairEntry | null;
}

type View = DyadicView & { label: string };

const SECTION: { key: "different" | "aligned" | "unknown"; title: string; hint: string }[] = [
  { key: "different", title: "Different", hint: "You both answered, and the answers differ. Differences are normal — they are things to talk about." },
  { key: "aligned", title: "Aligned", hint: "You both chose the same answer." },
  { key: "unknown", title: "Not enough information", hint: "One of you hasn't answered or shared, chose \"not sure\", or the answer depends on the situation." },
];

const CORRECTIONS: { kind: CorrectionKind; label: string }[] = [
  { kind: "NOT_WHAT_I_MEANT", label: "That's not what I meant" },
  { kind: "OUTDATED", label: "This is outdated" },
  { kind: "COMPARISON_WRONG", label: "This comparison is wrong" },
  { kind: "DONT_SHARE", label: "Leave my answer out" },
];

export default function PartnerComparison({ userId, partnerId, answers, skipped, expectations, storeCtx, toast, initialRepair }: Props) {
  const [view, setView] = useState<View | null>(null);
  const [loading, setLoading] = useState(false);

  const run = useCallback(async () => {
    setLoading(true);
    try {
      const deps = buildProductionRelationshipDeps();
      const [sharedWithMe, corrections] = await Promise.all([listSharedWithMe(userId), loadCorrections(userId, deps.backend)]);
      const values: ValuesRecord = { version: 1, answers, skippedCategories: skipped };
      const res = await createRelationshipAIService({ deps }).compareWithPartner({ userId, partnerId, values, expectations, sharedWithMe, corrections });
      setView(res);
    } catch (err) {
      toast({ title: "Couldn't compare", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [userId, partnerId, answers, skipped, expectations, toast]);

  const correct = async (r: DyadicResult, kind: CorrectionKind, note?: string) => {
    try {
      const deps = buildProductionRelationshipDeps();
      await addCorrection(userId, deps.backend, { comparisonKey: r.comparisonKey, kind, note }, new Date());
      if (kind === "DONT_SHARE") {
        // Also stop sharing the underlying answer, if it was shared.
        const own = answers.find((a) => a.questionId === r.comparisonKey);
        if (own?.shareId) await revokeShare(userId, own.shareId, { store: storeCtx });
      }
      toast({ title: "Updated" });
      await run();
    } catch {
      toast({ title: "Couldn't save that", variant: "destructive" });
    }
  };

  const total = view ? view.aligned.length + view.different.length + view.unknown.length : 0;

  return (
    <section className="space-y-3">
      <div className="rounded-2xl border border-border/60 bg-card p-4 space-y-2">
        <h2 className="text-sm font-semibold">Compare shared answers</h2>
        <p className="text-xs text-muted-foreground">
          Uses only your own answers and what your partner chose to share with you. Runs on this device. There is no score — just what aligns, what differs, and what isn't known yet.
        </p>
        <Button className="w-full" variant="secondary" onClick={run} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          {view ? "Refresh comparison" : "Compare"}
        </Button>
        {!partnerId && <p className="text-xs text-muted-foreground">Link a partner to compare shared answers.</p>}
        {view && <p className="text-[11px] text-muted-foreground">{view.label}</p>}
      </div>

      {view && total === 0 && (
        <p className="text-xs text-muted-foreground text-center py-4">Nothing to compare yet. Answer some Values questions, and ask your partner to share theirs.</p>
      )}

      {view && view.comparisons.length > 0 && <CompatibilityOverview comparisons={view.comparisons} />}

      {view && SECTION.map((s) => view[s.key].length > 0 && (
        <div key={s.key} className="space-y-2">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{s.title} · {view[s.key].length}</h3>
            <p className="text-[11px] text-muted-foreground">{s.hint}</p>
          </div>
          {view[s.key].map((r) => <ResultCard key={r.id} r={r} onCorrect={correct} />)}
        </div>
      ))}

      <ResponseSupportPanel userId={userId} toast={toast} />
      <RepairPanel userId={userId} partnerId={partnerId} storeCtx={storeCtx} toast={toast} initial={initialRepair} />
      <MemoryPanel userId={userId} partnerId={partnerId} storeCtx={storeCtx} toast={toast} />
    </section>
  );
}

function ResultCard({ r, onCorrect }: { r: DyadicResult; onCorrect: (r: DyadicResult, k: CorrectionKind, note?: string) => void }) {
  const [open, setOpen] = useState(false);
  const [context, setContext] = useState("");
  if (r.insufficientInformation) {
    return (
      <div className="rounded-2xl border border-border/60 bg-card p-4 text-xs text-muted-foreground">
        <p className="font-medium text-foreground">{r.area}</p>
        <p>{r.unknowns[0]}</p>
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-border/60 bg-card p-4 space-y-3 text-sm">
      <p className="text-xs font-medium text-muted-foreground">{r.area}</p>
      <div className="space-y-1">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">What each of you said</p>
        <p className="text-sm">{r.observation}</p>
      </div>
      <div className="space-y-1">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Comparison</p>
        <p>{r.comparison}</p>
      </div>
      {r.possibleExplanations.length > 0 && (
        <div className="space-y-1">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Possible reasons (none of these is known to be true)</p>
          <ul className="list-disc pl-4 text-xs text-muted-foreground space-y-0.5">{r.possibleExplanations.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}
      <div className="space-y-1">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Not known</p>
        <ul className="list-disc pl-4 text-xs text-muted-foreground space-y-0.5">{r.unknowns.map((u) => <li key={u}>{u}</li>)}</ul>
      </div>
      <div className="rounded-xl bg-muted/40 p-3 flex gap-2">
        <MessageCircleQuestion className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
        <p className="text-sm">{r.conversationPrompt}</p>
      </div>
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 text-[11px] text-muted-foreground">
        {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />} Correct this
      </button>
      {open && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {CORRECTIONS.map((c) => (
              <button key={c.kind} onClick={() => onCorrect(r, c.kind)} className="rounded-full border border-border/60 px-2.5 py-1 text-[11px]">{c.label}</button>
            ))}
          </div>
          <Textarea value={context} onChange={(e) => setContext(e.target.value)} placeholder="Add context in your own words (optional)" className="text-xs min-h-[60px]" maxLength={300} />
          <Button size="sm" variant="outline" disabled={context.trim().length < 2} onClick={() => { onCorrect(r, "ADD_CONTEXT", context); setContext(""); }}>Add context</Button>
        </div>
      )}
    </div>
  );
}

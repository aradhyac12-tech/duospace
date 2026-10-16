/** Reflection "Values" tab. Extracted from pages/Reflection.tsx. */
import { tr } from "@/lib/i18n";
import { useMemo, useState } from "react";
import { Sparkles, Loader2, HelpCircle, X as XIcon, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { hapticLight, hapticNotification } from "@/lib/haptics";
import { ALL_VALUE_CATEGORIES, CATEGORY_LABEL, AnswerMode, questionsForCategory, createValueAnswer, updateValueAnswer, setCategorySkipped, previewValueAnswer, withHash, confirmShare, type ValueCategory, type ValueAnswer, type SharePreview } from "@/lib/relationship";
import { createRelationshipAIService } from "@/lib/relationship/service";
import { friendlyError, SharePreviewDialog } from "@/components/relationship/reflectionShared";

const CATEGORY_ORDER: ValueCategory[] = [...ALL_VALUE_CATEGORIES];

export default function ValuesTab({ userId, storeCtx, deps, answers, skipped, partnerId, analyzing, setAnalyzing, onChanged, toast }: any) {
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
      toast({ title: tr("p1.rel.err.save"), description: friendlyError(err), variant: "destructive" });
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
      toast({ title: tr("p1.rel.err.reflect"), description: friendlyError(err), variant: "destructive" });
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
      toast({ title: tr("p1.rel.shared") });
      setPreview(null);
      await onChanged();
    } catch (err) {
      toast({ title: tr("p1.rel.err.share"), description: friendlyError(err), variant: "destructive" });
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
        <span className="text-[12px] text-muted-foreground">{tr("p1.rel.notApplicable")}</span>
        <Switch checked={isSkipped} onCheckedChange={(v) => {
          setCategorySkipped(userId, category, v, storeCtx).then(onChanged).catch((err) => {
            toast({ title: tr("p1.rel.err.save"), description: friendlyError(err), variant: "destructive" });
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
                <HelpCircle className="h-3.5 w-3.5" /> {tr("p1.rel.notSure")}
              </button>
              <button onClick={() => answer(q.id, "PREFER_NOT_TO_ANSWER")} className={`flex items-center gap-1 text-[11px] ${a?.mode === "PREFER_NOT_TO_ANSWER" ? "text-accent" : "text-muted-foreground"}`}>
                <XIcon className="h-3.5 w-3.5" /> {tr("p1.rel.preferNot")}
              </button>
              {a?.mode === "ANSWERED" && partnerId && (
                <button onClick={() => openShare(a, q.prompt)} className="flex items-center gap-1 text-[11px] text-muted-foreground ml-auto">
                  <Share2 className="h-3.5 w-3.5" /> {a.visibility === "SHARED_WITH_PARTNER" ? tr("p1.rel.shared") : tr("p1.rel.share")}
                </button>
              )}
            </div>
          </div>
        );
      })}

      <Button variant="secondary" className="w-full" onClick={runAnalysis} disabled={analyzing || answers.length === 0}>
        {analyzing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Sparkles className="h-4 w-4 mr-2" />}
        {tr("p1.rel.val.reflect")}
      </Button>
      <SharePreviewDialog preview={preview} onCancel={() => setPreview(null)} onConfirm={confirm} sharing={sharing} />
    </div>
  );
}

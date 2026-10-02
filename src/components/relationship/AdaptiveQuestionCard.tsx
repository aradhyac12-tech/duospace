/**
 * Phase 3M Stage 3 — adaptive onboarding, one question at a time.
 * The app chooses the dimension (adaptive.ts); cloud AI may only reword the
 * lead-in. Answer options always come from the static question bank.
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { nextAdaptiveQuestion, type AdaptiveOutcome } from "@/lib/relationship/compatibility";
import { ALL_VALUE_CATEGORIES, AnswerMode, type ValueAnswer, type ValueCategory } from "@/lib/relationship/types";
import { questionsForCategory } from "@/lib/relationship/questions";
import { createValueAnswer, type StoreCtx } from "@/lib/relationship/stores";

interface Props {
  userId: string;
  answers: ValueAnswer[];
  storeCtx: StoreCtx;
  onChanged: () => Promise<void> | void;
  toast: (t: { title: string; description?: string; variant?: "destructive" }) => void;
}

export default function AdaptiveQuestionCard({ userId, answers, storeCtx, onChanged, toast }: Props) {
  const [asked, setAsked] = useState<ValueCategory[]>([]);
  const [count, setCount] = useState(0);
  const [step, setStep] = useState<AdaptiveOutcome | null>(null);
  const [started, setStarted] = useState(false);

  const answered = ALL_VALUE_CATEGORIES.filter((c) => answers.some((a) => a.category === c && a.mode === AnswerMode.ANSWERED));

  const load = useCallback(async (askedNow: ValueCategory[], n: number) => {
    setStep(null);
    setStep(await nextAdaptiveQuestion({ answered, asked: askedNow, questionsThisSession: n }));
  }, [answered.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (started && !step) void load(asked, count); }, [started]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!started) {
    return (
      <div className="rounded-2xl border border-border/60 bg-card p-4 space-y-2">
        <h3 className="text-sm font-semibold">Get to know your preferences</h3>
        <p className="text-xs text-muted-foreground">A few short questions, one at a time. You can skip any of them.</p>
        <Button size="sm" className="w-full" onClick={() => setStarted(true)}>Start</Button>
      </div>
    );
  }
  if (!step) return <p className="text-xs text-muted-foreground text-center py-3">One moment…</p>;
  if (step.done) {
    return <p className="rounded-2xl border border-border/60 bg-card p-4 text-sm">That's enough for now — thank you. You can answer more any time.</p>;
  }

  const q = questionsForCategory(step.category).find((x) => !answers.some((a) => a.questionId === x.id)) ?? questionsForCategory(step.category)[0];
  const respond = async (mode: "ANSWERED" | "NOT_SURE" | "PREFER_NOT_TO_ANSWER", choiceId?: string) => {
    try {
      if (q && !answers.some((a) => a.questionId === q.id)) {
        await createValueAnswer(userId, { questionId: q.id, mode: mode as never, choiceId: choiceId ?? null }, storeCtx);
        await onChanged();
      }
      const nextAsked = [...asked, step.category];
      setAsked(nextAsked); setCount(count + 1);
      await load(nextAsked, count + 1);
    } catch {
      toast({ title: "Couldn't save", variant: "destructive" });
    }
  };

  return (
    <div className="rounded-2xl border border-border/60 bg-card p-4 space-y-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{step.label}</p>
      <p className="text-sm font-medium">{step.text}</p>
      {q && (
        <div className="space-y-1.5">
          {q.options.map((o) => (
            <button key={o.id} onClick={() => respond("ANSWERED", o.id)} className="w-full text-left rounded-xl border border-border/60 px-3 py-2 text-sm">{o.label}</button>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <Button size="sm" variant="ghost" onClick={() => respond("NOT_SURE")}>Not sure</Button>
        <Button size="sm" variant="ghost" onClick={() => respond("PREFER_NOT_TO_ANSWER")}>Prefer not to answer</Button>
      </div>
    </div>
  );
}

/**
 * Phase 3C — private conflict-repair preparation. Step-by-step, private by
 * default, exit any time, safety hold stops everything except exit.
 * Only an explicitly previewed and confirmed MESSAGE can be shared.
 */
import { useCallback, useEffect, useState } from "react";
import { listSharedByMe, listSharedWithMe } from "@/lib/relationship/sharing";
import { recordRepairFeedback, type RepairOutcome as FeedbackOutcome } from "@/lib/relationship/memory";
import { loadConsents, loadMemory, saveMemory } from "@/lib/relationship/memory/store";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { createRelationshipAIService } from "@/lib/relationship/service";
import { buildProductionRelationshipDeps } from "@/lib/relationship/production";
import { detectEmergencyRegion, getLanguageCode } from "@/lib/i18n";
import { detectLanguage, isRelLang } from "@/lib/relationship/i18n/lang";
import { newSession, transition, safetyGuidance, type RepairAnswers, type RepairEdit, type RepairResult, type RepairSession, type RepairStage } from "@/lib/relationship/repair";
import { deriveRepairThreads, previewRepairShare, shareRepairMessage, withdrawRepairMessage } from "@/lib/relationship/repair/share";
import type { SharePreview } from "@/lib/relationship/types";
import type { StoreCtx } from "@/lib/relationship/stores";

type Q = { field: keyof RepairAnswers; label: string };
const STEPS: Partial<Record<RepairStage, { title: string; qs: Q[] }>> = {
  FACTS: { title: "What happened", qs: [{ field: "whatHappened", label: "What happened?" }, { field: "concreteEvent", label: "What do I know happened, as a concrete event?" }, { field: "partnerSaid", label: "Their exact words, if you want to include them (optional)" }] },
  IMPACT: { title: "Impact", qs: [{ field: "myExperience", label: "What did I experience or feel?" }, { field: "whatMatteredToMe", label: "What mattered to me?" }] },
  UNDERSTANDING: { title: "Understanding", qs: [{ field: "whatMatteredToPartnerGuess", label: "What do I think mattered to my partner? (a guess)" }, { field: "uncertainAbout", label: "What am I uncertain about?" }, { field: "wishPartnerUnderstood", label: "What do I wish my partner understood?" }, { field: "wantToUnderstand", label: "What do I want to understand better about them?" }] },
  RESPONSIBILITY: { title: "My part", qs: [{ field: "myResponsibility", label: "What part of my behaviour do I take responsibility for? (optional)" }, { field: "stillNeedToExplain", label: "What part do I still need to explain?" }] },
  BOUNDARY: { title: "Boundary", qs: [{ field: "boundary", label: "What boundary do I need to keep? (optional)" }] },
  REPAIR_GOAL: { title: "Repair", qs: [{ field: "repairLooksLike", label: "What would repair look like to me?" }] },
  REQUEST: { title: "Request", qs: [{ field: "specificChange", label: "What specific change would help next time?" }] },
  NEXT_TIME: { title: "Next time", qs: [{ field: "willingToDo", label: "What am I willing to do differently?" }] },
};
const EDITS: { e: RepairEdit; label: string }[] = [
  { e: "NOT_WHAT_I_MEANT", label: "Not what I meant" }, { e: "TOO_APOLOGETIC", label: "Too apologetic" }, { e: "TOO_DEFENSIVE", label: "Too defensive" },
  { e: "TOO_FORMAL", label: "Too formal" }, { e: "KEEP_MY_BOUNDARY", label: "Keep my boundary" }, { e: "MAKE_SHORTER", label: "Make it shorter" },
  { e: "ASK_INSTEAD_OF_ASSUME", label: "Ask instead of assume" }, { e: "DONT_SHARE", label: "Don't share this" },
];
const Label = ({ children }: { children: React.ReactNode }) => <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{children}</p>;

/** Lightweight entry from "Understand": open straight at the relevant step with their words; "walk" = full flow. */
export type RepairEntry = { partnerSaid: string; mode: "own" | "explain" | "boundary" | "walk" };

export default function RepairPanel({ userId, partnerId, storeCtx, toast, initial }: { userId: string; partnerId: string | null; storeCtx: StoreCtx; toast: (t: { title: string; description?: string; variant?: "destructive" }) => void; initial?: RepairEntry | null }) {
  const [s, setS] = useState<RepairSession | null>(null);
  // Start from a lightweight entry once; the safety gate still runs on the partner's words.
  useEffect(() => {
    if (!initial?.partnerSaid) return;
    const base = newSession({ id: crypto.randomUUID(), conflictId: crypto.randomUUID(), userId, relationshipId: partnerId, nowMs: Date.now() });
    const answers = { partnerSaid: initial.partnerSaid.slice(0, 500), rememberDifferently: initial.mode === "explain" ? true : undefined, cannotAgreeToRequest: initial.mode === "boundary" ? true : undefined };
    const r = transition(base, { type: "ANSWER", answers });
    const stage = r.session.stage === "SAFETY_HOLD" ? "SAFETY_HOLD" : initial.mode === "boundary" ? "BOUNDARY" : initial.mode === "walk" ? "PAUSE" : "RESPONSIBILITY";
    setS({ ...r.session, stage });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);
  const [res, setRes] = useState<RepairResult | null>(null);
  const [edits, setEdits] = useState<RepairEdit[]>([]);
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState<SharePreview | null>(null);
  const [busy, setBusy] = useState(false);
  // RECEIVED / RESPONDED — derived only from rows RLS lets this user see.
  const [threads, setThreads] = useState<ReturnType<typeof deriveRepairThreads> | null>(null);
  const [replyFor, setReplyFor] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [replyPreview, setReplyPreview] = useState<SharePreview | null>(null);
  const loadThreads = useCallback(async () => {
    const [inbox, outbox] = await Promise.all([listSharedWithMe(userId), listSharedByMe(userId)]);
    setThreads(deriveRepairThreads(inbox, outbox, Date.now()));
  }, [userId]);
  useEffect(() => { loadThreads().catch(() => {}); }, [loadThreads]);
  const sendReply = async () => {
    if (!replyPreview) return;
    setBusy(true);
    try {
      await shareRepairMessage(userId, replyPreview, { gate: buildProductionRelationshipDeps().gate, store: storeCtx });
      toast({ title: "Reply shared" });
      setReplyFor(null); setReplyText(""); setReplyPreview(null);
      await loadThreads();
    } catch { toast({ title: "Couldn't share", variant: "destructive" }); } finally { setBusy(false); }
  };

  const start = () => { setS(newSession({ id: crypto.randomUUID(), conflictId: crypto.randomUUID(), userId, relationshipId: partnerId, nowMs: Date.now() })); setRes(null); setEdits([]); setPreview(null); };
  const exit = () => { setS(null); setRes(null); setPreview(null); setDraft(""); }; // nothing is kept
  const apply = (e: Parameters<typeof transition>[1], ctx?: Parameters<typeof transition>[2]) => {
    if (!s) return;
    const r = transition(s, e, ctx);
    if (r.refused && e.type !== "ANSWER") toast({ title: r.refused });
    setS(r.session);
  };
  const answer = (field: keyof RepairAnswers, value: string | boolean) => apply({ type: "ANSWER", answers: { [field]: value } as Partial<RepairAnswers> });

  const review = async (nextEdits: RepairEdit[]) => {
    if (!s) return;
    setBusy(true);
    try {
      const out = await createRelationshipAIService({ deps: buildProductionRelationshipDeps() }).prepareRepair({ ...s, stage: "REVIEW" }, { edits: nextEdits, language: getLanguageCode() });
      setRes(out.result); setEdits(nextEdits);
      setDraft(out.result.proposedMessage === "INSUFFICIENT_INFORMATION" ? "" : out.result.proposedMessage);
      if (s.stage === "NEXT_TIME") apply({ type: "NEXT" });
    } catch (err) {
      toast({ title: "Couldn't prepare this", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally { setBusy(false); }
  };

  const share = async () => {
    if (!s || !preview) return;
    setBusy(true);
    try {
      const row = await shareRepairMessage(userId, preview, { gate: buildProductionRelationshipDeps().gate, store: storeCtx });
      setS(transition(s, { type: "SHARED", shareId: row.id }).session); setPreview(null);
      loadThreads().catch(() => {});
      toast({ title: "Shared" });
    } catch { toast({ title: "Couldn't share", variant: "destructive" }); } finally { setBusy(false); }
  };
  const withdraw = async () => {
    if (!s) return;
    try {
      if (s.shareId) await withdrawRepairMessage(userId, s.shareId, { store: storeCtx });
      setS(transition(s, { type: "WITHDRAWN" }).session); setPreview(null);
      toast({ title: s.shareId ? "Withdrawn — your partner can no longer see it" : "Not shared" });
    } catch { toast({ title: "Couldn't withdraw", variant: "destructive" }); }
  };

  if (!s) {
    return (
      <div className="rounded-2xl border border-border/60 bg-card p-4 space-y-2">
        <h2 className="text-sm font-semibold">Prepare to repair a conflict</h2>
        <p className="text-xs text-muted-foreground">Private. Helps you separate what happened from how it felt and what you're assuming, and prepare what you'd like to say. DuoSpace doesn't decide who is right. Nothing is saved or shared unless you choose to share a message.</p>
        <Button variant="secondary" className="w-full" onClick={start}>Start</Button>
        {threads && threads.receivedMessages.length > 0 && (
          <div className="space-y-2 pt-2">
            <Label>Shared with you by your partner</Label>
            {threads.receivedMessages.map((m) => (
              <div key={m.id} className="rounded-xl bg-muted/40 p-3 space-y-2">
                <p className="text-sm">{m.message}</p>
                <p className="text-[11px] text-muted-foreground">{m.state === "RESPONDED" ? "You replied" : "Received"}</p>
                {m.state === "RECEIVED" && replyFor !== m.id && <Button size="sm" variant="outline" onClick={() => { setReplyFor(m.id); setReplyPreview(null); }}>Reply</Button>}
                {replyFor === m.id && (
                  <div className="space-y-2">
                    <Textarea value={replyText} onChange={(e) => { setReplyText(e.target.value); setReplyPreview(null); }} placeholder="Your reply, in your own words" className="text-sm min-h-[60px]" maxLength={2000} />
                    {!replyPreview
                      ? <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => { setReplyFor(null); setReplyText(""); }}>Cancel</Button><Button size="sm" className="flex-1" disabled={!replyText.trim()} onClick={async () => setReplyPreview(await previewRepairShare(crypto.randomUUID(), replyText, m.id))}>Preview</Button></div>
                      : <div className="space-y-1">{replyPreview.lines.map((l) => <p key={l.label} className="text-xs"><span className="text-muted-foreground">{l.label}: </span>{l.value}</p>)}<div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => setReplyPreview(null)}>Don't send</Button><Button size="sm" className="flex-1" disabled={busy} onClick={sendReply}>Share reply</Button></div></div>}
                  </div>
                )}
              </div>
            ))}
            <p className="text-[11px] text-muted-foreground">Only the message they chose to send. Opening it doesn't tell them anything, and you don't have to reply.</p>
          </div>
        )}
      </div>
    );
  }

  const step = STEPS[s.stage];
  // Safety text follows the language the user is WRITING in (else the app language).
  const typed = Object.values(s.answers).filter((x): x is string => typeof x === "string").join(" ");
  const appLang = getLanguageCode();
  const guidanceLang = detectLanguage(typed).lang !== "en" ? detectLanguage(typed).lang : isRelLang(appLang) ? appLang : "en";
  const SAFETY_GUIDANCE = safetyGuidance(guidanceLang, detectEmergencyRegion());
  return (
    <div className="rounded-2xl border border-border/60 bg-card p-4 space-y-3 text-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{s.stage === "SAFETY_HOLD" ? SAFETY_GUIDANCE.title : step?.title ?? (s.stage === "PAUSE" ? "Pause" : "Review")}</h2>
        <button className="text-[11px] text-muted-foreground" onClick={exit}>Exit</button>
      </div>

      {s.stage === "SAFETY_HOLD" && <div className="space-y-2">{SAFETY_GUIDANCE.body.map((b) => <p key={b} className="text-xs">{b}</p>)}</div>}

      {s.stage === "PAUSE" && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">If things feel heated, it's okay to pause and come back when you can talk more clearly. You can stop at any step.</p>
          <Button size="sm" className="w-full" variant="secondary" onClick={() => apply({ type: "NEXT" })}>Continue</Button>
        </div>
      )}

      {step && (
        <div className="space-y-2">
          {step.qs.map((q) => (
            <div key={q.field} className="space-y-1">
              <p className="text-xs">{q.label}</p>
              <Textarea value={(s.answers[q.field] as string) ?? ""} onChange={(e) => answer(q.field, e.target.value)} className="text-sm min-h-[44px]" maxLength={500} />
            </div>
          ))}
          {s.stage === "RESPONSIBILITY" && <label className="flex items-center justify-between text-xs"><span>I want to apologise</span><Switch checked={!!s.answers.apologize} onCheckedChange={(v) => answer("apologize", v)} /></label>}
          {s.stage === "RESPONSIBILITY" && <label className="flex items-center justify-between text-xs"><span>I remember it differently</span><Switch checked={!!s.answers.rememberDifferently} onCheckedChange={(v) => answer("rememberDifferently", v)} /></label>}
          {s.stage === "RESPONSIBILITY" && <label className="flex items-center justify-between text-xs"><span>I don't agree with every interpretation</span><Switch checked={!!s.answers.disagreeWithInterpretation} onCheckedChange={(v) => answer("disagreeWithInterpretation", v)} /></label>}
          {s.stage === "BOUNDARY" && <label className="flex items-center justify-between text-xs"><span>I can't agree to what was asked</span><Switch checked={!!s.answers.cannotAgreeToRequest} onCheckedChange={(v) => answer("cannotAgreeToRequest", v)} /></label>}
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => apply({ type: "BACK" })}>Back</Button>
            {s.stage === "NEXT_TIME"
              ? <Button size="sm" className="flex-1" disabled={busy} onClick={() => review([])}>Review</Button>
              : <Button size="sm" className="flex-1" onClick={() => apply({ type: "NEXT" })}>Next</Button>}
          </div>
        </div>
      )}

      {(s.stage === "REVIEW" || s.stage === "SHARE" || s.stage === "COMPLETE") && res && (
        <div className="space-y-3">
          {res.facts.length > 0 && <div><Label>What happened (fact)</Label>{res.facts.map((f) => <p key={f.text}>{f.text}</p>)}</div>}
          {res.userExperience.length > 0 && <div><Label>Your experience</Label>{res.userExperience.map((f) => <p key={f.text}>{f.text}</p>)}</div>}
          {res.partnerUnderstanding.length > 0 && <div><Label>Interpretations and their words</Label>{res.partnerUnderstanding.map((f) => <p key={f.text} className={f.kind === "INTERPRETATION" ? "text-muted-foreground text-xs" : ""}>{f.text}</p>)}</div>}
          <div><Label>Not known</Label><ul className="list-disc pl-4 text-xs text-muted-foreground">{[...res.unknowns, ...res.possibilities].map((u) => <li key={u.text}>{u.text}</li>)}</ul></div>
          {res.communicationNotes.map((n) => <p key={n.text} className="text-xs text-muted-foreground">{n.text}</p>)}
          <div className="space-y-1">
            <Label>A message you could send (edit freely)</Label>
            {res.proposedMessage === "INSUFFICIENT_INFORMATION"
              ? <p className="text-xs text-muted-foreground">There isn't enough of your own information to build a message. You can go back and add more, or talk directly.</p>
              : <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} className="text-sm min-h-[110px]" />}
          </div>
          <div className="flex flex-wrap gap-1.5">{EDITS.map(({ e, label }) => <button key={e} disabled={busy} onClick={() => review(edits.includes(e) ? edits : [...edits, e])} className="rounded-full border border-border/60 px-2.5 py-1 text-[11px]">{label}</button>)}</div>
          <p className="text-[11px] text-muted-foreground">This is one possible way to say what you know and what you still want to understand. It isn't a verdict, and it can't promise how the conversation will go.</p>

          {s.stage === "REVIEW" && res.shareable && partnerId && draft.trim() && (
            <Button size="sm" variant="secondary" className="w-full" onClick={async () => {
              const r = transition(s, { type: "CONFIRM_SHARE_READY" }, { messageValid: true, shareBlocked: edits.includes("DONT_SHARE") });
              if (r.refused) { toast({ title: r.refused }); return; }
              setS(r.session); setPreview(await previewRepairShare(s.repairSessionId, draft));
            }}>Prepare to share this message</Button>
          )}
          {preview && s.shareState === "READY_TO_SHARE" && (
            <div className="rounded-xl bg-muted/40 p-3 space-y-2">
              {preview.lines.map((l) => <div key={l.label}><Label>{l.label}</Label><p className="text-xs">{l.value}</p></div>)}
              <div className="flex gap-2"><Button size="sm" variant="outline" onClick={withdraw}>Don't send</Button><Button size="sm" className="flex-1" disabled={busy} onClick={share}>Share with my partner</Button></div>
            </div>
          )}
          {s.shareState === "SHARED" && <Button size="sm" variant="outline" className="w-full" onClick={withdraw}>Withdraw</Button>}
          {s.shareState === "SHARED" && s.shareId && threads?.replyTo(s.shareId) && (
            <div className="rounded-xl bg-muted/40 p-3 space-y-1"><Label>Your partner replied</Label><p className="text-sm">{threads.replyTo(s.shareId)!.message}</p></div>
          )}
          <div className="space-y-1">
            <Label>Optional: did this conversation help?</Label>
            <div className="flex flex-wrap gap-1.5">{(["YES", "SOMEWHAT", "NO", "NOT_SURE"] as FeedbackOutcome[]).map((v) => (
              <button key={v} className="rounded-full border border-border/60 px-2.5 py-1 text-[11px]" onClick={async () => {
                const deps = buildProductionRelationshipDeps();
                const c = await loadConsents(userId, deps.backend);
                if (!c.store) { toast({ title: "Not saved — relationship memory is off" }); return; }
                const st = await loadMemory(userId, deps.backend, Date.now());
                await saveMemory(userId, deps.backend, recordRepairFeedback(st, { repairId: s.repairSessionId, topic: "conflict_repair", date: new Date().toISOString(), userOutcome: v, agreedAction: s.answers.willingToDo ?? null, issueOpen: v === "NO" ? true : null }, c), c);
                toast({ title: "Saved to your relationship memory" });
              }}>{v === "NOT_SURE" ? "Not sure" : v.charAt(0) + v.slice(1).toLowerCase()}</button>
            ))}</div>
            <p className="text-[11px] text-muted-foreground">Only saved if you've turned on relationship memory. Saves your answer here and, if you wrote one, what you said you're willing to do next time. DuoSpace never guesses this from replies or timing.</p>
          </div>
          <Button size="sm" variant="ghost" className="w-full" onClick={exit}>Finish</Button>
        </div>
      )}
    </div>
  );
}

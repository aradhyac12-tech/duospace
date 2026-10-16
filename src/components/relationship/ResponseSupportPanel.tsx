/**
 * Phase 3B — minimal response-support surface. Four sections kept visibly
 * separate (their words / possible meaning / not known / a reply you could
 * send), an understanding check, component-based reply the user edits, and
 * correction chips. Nothing is saved; the reply is the user's to send.
 */
import { useState } from "react";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { createRelationshipAIService } from "@/lib/relationship/service";
import { detectEmergencyRegion, getLanguageCode } from "@/lib/i18n";
import { buildProductionRelationshipDeps } from "@/lib/relationship/production";
import type { ResponseSupport, ResponseSupportInput, SupportCorrection } from "@/lib/relationship/responsiveness";

const CHIPS: { c: SupportCorrection; label: string }[] = [
  { c: "REGENERATE", label: "Try other wording" },
  { c: "NOT_WHAT_I_MEANT", label: "Not what I meant" },
  { c: "TOO_APOLOGETIC", label: "Too apologetic" },
  { c: "TOO_DEFENSIVE", label: "Too defensive" },
  { c: "TOO_FORMAL", label: "Too formal" },
  { c: "MAKE_CLEARER", label: "Make it clearer" },
  { c: "KEEP_MY_BOUNDARY", label: "Keep my boundary" },
  { c: "DONT_SHARE", label: "Don't share this" },
];

const Label = ({ children }: { children: React.ReactNode }) => <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{children}</p>;

export default function ResponseSupportPanel({ userId, toast }: { userId: string; toast: (t: { title: string; description?: string; variant?: "destructive" }) => void }) {
  const [f, setF] = useState<ResponseSupportInput>({ partnerMessage: "" });
  const [more, setMore] = useState(false);
  const [out, setOut] = useState<ResponseSupport | null>(null);
  const [draft, setDraft] = useState("");
  const [corr, setCorr] = useState<SupportCorrection[]>([]);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof ResponseSupportInput) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));

  const generate = async (corrections: SupportCorrection[]) => {
    setBusy(true);
    try {
      const svc = createRelationshipAIService({ deps: buildProductionRelationshipDeps() });
      const r = await svc.supportResponse(userId, f, { corrections, language: getLanguageCode(), region: detectEmergencyRegion() });
      setOut(r.support);
      setDraft(r.support.insufficientInformation ? "" : r.support.possibleResponse);
      setCorr(corrections);
    } catch (err) {
      toast({ title: "Couldn't help with this", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-border/60 bg-card p-4 space-y-3">
      <div>
        <h2 className="text-sm font-semibold">Help me respond</h2>
        <p className="text-xs text-muted-foreground">Separates what your partner actually said from what it might mean, and helps you reply in your own words. DuoSpace doesn't decide who is right, and you don't have to agree to be responsive. Nothing here is saved.</p>
      </div>
      <Textarea value={f.partnerMessage} onChange={set("partnerMessage")} placeholder="What your partner said" className="text-sm min-h-[60px]" maxLength={400} />
      <Textarea value={f.whatIHeard ?? ""} onChange={set("whatIHeard")} placeholder="What I think they meant (optional — for an understanding check)" className="text-sm min-h-[44px]" maxLength={300} />
      <button className="text-[11px] text-muted-foreground" onClick={() => setMore((m) => !m)}>{more ? "Fewer options" : "Add my side, a request or a boundary"}</button>
      {more && (
        <div className="space-y-2">
          <Textarea value={f.myExperience ?? ""} onChange={set("myExperience")} placeholder="What I experienced" className="text-sm min-h-[44px]" maxLength={300} />
          <Textarea value={f.myOwnAction ?? ""} onChange={set("myOwnAction")} placeholder="Something I want to own (optional)" className="text-sm min-h-[44px]" maxLength={200} />
          <Textarea value={f.myRequest ?? ""} onChange={set("myRequest")} placeholder="What would help me next time (optional)" className="text-sm min-h-[44px]" maxLength={200} />
          <Textarea value={f.myBoundary ?? ""} onChange={set("myBoundary")} placeholder="A boundary I want to keep (optional)" className="text-sm min-h-[44px]" maxLength={300} />
          <label className="flex items-center justify-between text-xs"><span>I see it differently</span><Switch checked={!!f.seeItDifferently} onCheckedChange={(v) => setF((p) => ({ ...p, seeItDifferently: v }))} /></label>
          <label className="flex items-center justify-between text-xs"><span>I want to apologise</span><Switch checked={!!f.apologize} onCheckedChange={(v) => setF((p) => ({ ...p, apologize: v }))} /></label>
        </div>
      )}
      <Button className="w-full" variant="secondary" disabled={busy || f.partnerMessage.trim().length < 1} onClick={() => generate([])}>Help me respond</Button>

      {out?.refusal && (
        <div className="rounded-xl bg-muted/40 p-3 text-sm space-y-1">
          <p className="text-xs text-muted-foreground">{out.refusal}</p>
          <p>{out.possibleResponse}</p>
        </div>
      )}

      {out?.safetyHold && (
        <div className="rounded-xl bg-muted/40 p-3 space-y-1">{out.notes.map((n) => <p key={n} className="text-xs">{n}</p>)}</div>
      )}

      {out && !out.refusal && !out.safetyHold && (
        <div className="space-y-3 text-sm">
          <div className="space-y-1"><Label>What they said</Label><p>“{out.whatPartnerExplicitlySaid.text}”</p></div>
          {out.whatSeemsToMatter.length > 0 && (
            <div className="space-y-1"><Label>What may matter</Label>
              <ul className="list-disc pl-4 text-xs space-y-0.5">{out.whatSeemsToMatter.map((m) => <li key={m.text} className={m.kind === "TENTATIVE" ? "text-muted-foreground" : ""}>{m.text}</li>)}</ul>
            </div>
          )}
          <div className="space-y-1"><Label>Not known</Label>
            <ul className="list-disc pl-4 text-xs text-muted-foreground space-y-0.5">{out.whatIsUnknown.map((u) => <li key={u}>{u}</li>)}</ul>
          </div>
          {out.clarificationFirst && <div className="space-y-1"><Label>Worth asking first</Label><p>{out.clarifyingQuestion}</p></div>}
          {out.notes.map((n) => <p key={n} className="text-xs text-muted-foreground">{n}</p>)}
          <div className="space-y-1">
            <Label>A reply you could send (edit freely)</Label>
            {out.insufficientInformation
              ? <p className="text-xs text-muted-foreground">{out.uncertainty}</p>
              : <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} className="text-sm min-h-[90px]" />}
          </div>
          {!out.insufficientInformation && (
            <Button size="sm" variant="outline" onClick={() => navigator.clipboard?.writeText(draft).then(() => toast({ title: "Copied" }), () => {})}>
              <Copy className="h-3.5 w-3.5 mr-1" /> Copy
            </Button>
          )}
          <div className="flex flex-wrap gap-1.5">
            {CHIPS.map(({ c, label }) => (
              <button key={c} disabled={busy} onClick={() => generate([...corr, c])} className="rounded-full border border-border/60 px-2.5 py-1 text-[11px]">{label}</button>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">{out.uncertainty} The best next step is talking it through together.</p>
        </div>
      )}
    </div>
  );
}

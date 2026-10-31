/** Reflection "Expectations" tab. Extracted from pages/Reflection.tsx. */
import { tr } from "@/lib/i18n";
import { useState } from "react";
import { Sparkles, Loader2, Share2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { hapticLight, hapticNotification } from "@/lib/haptics";
import { ALL_VALUE_CATEGORIES, CATEGORY_LABEL, TYPE_LABEL, IMPORTANCE_LABEL, createExpectation, setExpectationStatus, deleteExpectation, previewExpectation, withHash, confirmShare, RelationshipError, type ValueCategory, type Expectation, type ExpectationType, type Importance, type SharePreview } from "@/lib/relationship";
import { createRelationshipAIService } from "@/lib/relationship/service";
import { friendlyError, SharePreviewDialog } from "@/components/relationship/reflectionShared";

const CATEGORY_ORDER: ValueCategory[] = [...ALL_VALUE_CATEGORIES];

const EXPECTATION_TYPES: ExpectationType[] = ["PREFERENCE", "EXPECTATION", "BOUNDARY"];
const IMPORTANCE_LEVELS: Importance[] = ["LOW", "MEDIUM", "HIGH"];

export default function ExpectationsTab({ userId, storeCtx, deps, items, partnerId, analyzing, setAnalyzing, onChanged, toast }: any) {
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
        toast({ title: tr("p1.rel.err.save"), description: friendlyError(err), variant: "destructive" });
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
      toast({ title: tr("p1.rel.err.update"), description: friendlyError(err), variant: "destructive" });
    }
  };
  const remove = async (id: string) => {
    try {
      await deleteExpectation(userId, id, storeCtx);
      await onChanged();
    } catch (err) {
      toast({ title: tr("p1.rel.err.delete"), description: friendlyError(err), variant: "destructive" });
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
      toast({ title: tr("p1.rel.err.reflect"), description: friendlyError(err), variant: "destructive" });
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
      toast({ title: tr("p1.rel.shared") });
      setPreview(null);
      await onChanged();
    } catch (err) {
      toast({ title: tr("p1.rel.err.share"), description: friendlyError(err), variant: "destructive" });
    } finally {
      setSharing(false);
    }
  };

  const active = (items as Expectation[]).filter((e) => e.status === "ACTIVE");

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-card border border-border/60 p-4 space-y-3">
        <p className="text-sm font-medium">{tr("p1.rel.exp.addTitle")}</p>
        <select value={category} onChange={(e) => setCategory(e.target.value as ValueCategory)} className="w-full rounded-lg border border-border/50 bg-muted/40 px-3 py-2 text-sm">
          {CATEGORY_ORDER.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
        </select>
        <Textarea value={statement} onChange={(e) => setStatement(e.target.value)} placeholder={tr("p1.rel.exp.placeholder")} rows={2} maxLength={280} />
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
                  <Share2 className="h-3.5 w-3.5" /> {item.visibility === "SHARED_WITH_PARTNER" ? tr("p1.rel.shared") : tr("p1.rel.share")}
                </button>
              )}
              <button onClick={() => archive(item.id)} className="text-[11px] text-muted-foreground ml-auto">{tr("p1.rel.notRelevant")}</button>
              <button onClick={() => remove(item.id)} className="text-[11px] text-destructive flex items-center gap-1"><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          </div>
        ))}
        {active.length === 0 && <p className="text-[12px] text-muted-foreground text-center py-4">{tr("p1.rel.exp.empty")}</p>}
      </div>

      <Button variant="secondary" className="w-full" onClick={runAnalysis} disabled={analyzing || active.length === 0}>
        {analyzing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Sparkles className="h-4 w-4 mr-2" />}
        {tr("p1.rel.exp.reflect")}
      </Button>

      <Dialog open={confirmBoundaryOpen} onOpenChange={setConfirmBoundaryOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tr("p1.rel.exp.boundaryTitle")}</DialogTitle>
            <DialogDescription>{tr("p1.rel.exp.boundaryBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setConfirmBoundaryOpen(false)}>{tr("p1.rel.cancel")}</Button>
            <Button onClick={() => { setConfirmBoundaryOpen(false); doCreate(true); }}>{tr("p1.rel.exp.boundaryYes")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <SharePreviewDialog preview={preview} onCancel={() => setPreview(null)} onConfirm={confirm} sharing={sharing} />
    </div>
  );
}

// ── Communication reflection ─────────────────────────────────────────────

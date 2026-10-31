/** Reflection "Reflect" tab (free-text prompts → local reflection). Extracted from pages/Reflection.tsx. */
import { tr } from "@/lib/i18n";
import { useState } from "react";
import { MessageCircleHeart, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { hapticNotification } from "@/lib/haptics";
import { REFLECTION_PROMPTS, REFLECTION_FIELD_KEYS, saveReflection, type ReflectionFields } from "@/lib/relationship";
import { createRelationshipAIService } from "@/lib/relationship/service";
import { friendlyError } from "@/components/relationship/reflectionShared";

export default function ReflectTab({ userId, storeCtx, deps, analyzing, setAnalyzing, onChanged, toast }: any) {
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
      toast({ title: tr("p1.rel.err.process"), description: friendlyError(err), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {REFLECTION_FIELD_KEYS.map((key) => (
        <div key={key} className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">{REFLECTION_PROMPTS[key]}</p>
          <Textarea value={fields[key] ?? ""} onChange={(e) => set(key, e.target.value)} rows={3} maxLength={2000} placeholder={tr("p1.rel.reflect.placeholder")} />
        </div>
      ))}
      <label className="flex items-center justify-between rounded-xl border border-border/50 px-3 py-2.5">
        <span className="text-[12px] text-muted-foreground">{tr("p1.rel.reflect.keep")}</span>
        <Switch checked={keepOnDevice} onCheckedChange={setKeepOnDevice} />
      </label>
      <Button className="w-full" onClick={submit} disabled={saving || !hasAny}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <MessageCircleHeart className="h-4 w-4 mr-2" />}
        {tr("p1.rel.reflect.reflect")}
      </Button>
      <p className="text-[11px] text-muted-foreground leading-relaxed">
        {tr("p1.rel.reflect.note")}
      </p>
    </div>
  );
}

// ── Insights ─────────────────────────────────────────────────────────────

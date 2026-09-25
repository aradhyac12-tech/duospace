import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Sparkles, ShieldOff, Loader2, Download } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { hapticLight } from "@/lib/haptics";
import { saveOrShareFile } from "@/lib/fileExport";
import {
  ConsentFeature, getAllConsents, grantConsent, revokeConsent, exportPrivacyData,
} from "@/lib/privacy/consent";
import { isConsentActive } from "@/lib/privacy/consentFeatures";
import { FEATURE_CAPABILITIES } from "@/lib/privacy/privacyGate";

/**
 * Privacy & AI Data settings — Phase 1 privacy/consent foundation.
 * See .ai/CONSENT_MODEL.md and .ai/PRIVACY_MODEL.md.
 *
 * Phase 2A (Relationship Intelligence V1) turned on exactly three
 * capabilities: AI_PROCESSING, RELATIONSHIP_INSIGHTS, SHARED_INSIGHTS —
 * see .ai/DO_NOT_BUILD.md for what is still frozen (multimodal inference,
 * any relationship score, partner surveillance). Toggling these three now
 * has a real, immediate effect: RELATIONSHIP_INSIGHTS gates every call in
 * src/lib/relationship/pipeline.ts, and SHARED_INSIGHTS gates every call
 * in src/lib/relationship/sharing.ts (checked fresh on every analysis /
 * every share — revoking here stops the very next one). Every other
 * toggle below still writes a genuine, auditable consent record for
 * whenever a feature behind it ships. ANALYTICS/CRASH_DIAGNOSTICS are
 * also already live (telemetry.ts).
 */

const FEATURE_INFO: Array<{ feature: ConsentFeature; label: string; description: string }> = [
  { feature: ConsentFeature.ANALYTICS, label: "Usage analytics", description: "Minimal, non-content event data (e.g. \"feature enabled\") to help improve the app. Never message content, mood details, or AI insights." },
  { feature: ConsentFeature.CRASH_DIAGNOSTICS, label: "Crash diagnostics", description: "Error reports with secrets and message content automatically redacted before anything is recorded." },
  { feature: ConsentFeature.AI_PROCESSING, label: "AI processing (general)", description: "Master switch for any on-device AI feature. Required, alongside Relationship insights below, for Relationship Reflection." },
  { feature: ConsentFeature.RELATIONSHIP_INSIGHTS, label: "Relationship insights", description: "Powers Relationship Reflection (Values, Expectations, Communication Reflection) in the Hub. Structured, uncertainty-labeled reflections built only from what you type or select — never a single score, and never a claim about your partner's inner state." },
  { feature: ConsentFeature.MOOD_PROCESSING, label: "Save mood readings", description: "Lets the Daily Mood camera read (a mood label, never video or photos) be saved to your account. Off means the read is shown to you and nothing is stored." },
  { feature: ConsentFeature.CAMERA_ANALYSIS, label: "Camera-based features", description: "Peek Guard and Daily Mood only analyse your own camera, on-device, never your partner's, and never uploaded raw. Each still has its own switch in Security & Privacy." },
  { feature: ConsentFeature.MICROPHONE_ANALYSIS, label: "Microphone-based features", description: "Only ever processes your own microphone input, on-device, for your own use — never uploaded raw." },
  { feature: ConsentFeature.VOICE_PROCESSING, label: "Voice processing", description: "Not currently used by any feature." },
  { feature: ConsentFeature.VIDEO_PROCESSING, label: "Video processing", description: "Not currently used by any feature." },
  { feature: ConsentFeature.CLOUD_AI_PROCESSING, label: "Cloud AI processing", description: "Off by default everywhere. Raw microphone/camera/video data can never be sent to the cloud regardless of this setting — see the Privacy & AI whitepaper." },
  { feature: ConsentFeature.SHARED_INSIGHTS, label: "Sharing insights with your partner", description: "Nothing is ever shared automatically. This controls whether you can explicitly share one values answer, expectation, or insight at a time from Relationship Reflection — you always see exactly what will be shared first." },
];

const PrivacyAISettings = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [states, setStates] = useState<Partial<Record<ConsentFeature, boolean>>>({});
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<ConsentFeature | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        // One round trip for every feature's state, instead of firing a
        // separate hasConsent() call per toggle (11 concurrent requests
        // racing an empty cache) — that fan-out was what made this page
        // slow to load.
        const records = await getAllConsents(user.id);
        const byFeature = new Map(records.map((r) => [r.feature, r]));
        const entries = FEATURE_INFO.map(({ feature }) => {
          const active = isConsentActive(byFeature.get(feature));
          return [feature, active] as const;
        });
        if (!cancelled) setStates(Object.fromEntries(entries));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const toggle = async (feature: ConsentFeature, next: boolean) => {
    if (!user) return;
    hapticLight();
    setPending(feature);
    setStates((s) => ({ ...s, [feature]: next })); // optimistic
    try {
      if (next) await grantConsent(user.id, feature, "settings_screen");
      else await revokeConsent(user.id, feature);
    } catch {
      setStates((s) => ({ ...s, [feature]: !next })); // revert on failure
      toast({ title: "Couldn't save", description: "Try again in a moment.", variant: "destructive" });
    } finally {
      setPending(null);
    }
  };

  const [exporting, setExporting] = useState(false);
  const handleExport = async () => {
    if (!user || exporting) return;
    hapticLight();
    setExporting(true);
    try {
      const json = await exportPrivacyData(user.id);
      await saveOrShareFile({
        fileName: `duospace-privacy-data-${new Date().toISOString().slice(0, 10)}.json`,
        data: json,
        mimeType: "application/json",
        dialogTitle: "Export privacy data",
      });
    } catch {
      toast({ title: "Couldn't export", description: "Try again in a moment.", variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }}
      className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-24 bg-background"
    >
      <PageHeader title="Privacy & AI Data" subtitle="What AI features can access — every one below is off by default" />

      <div className="px-5 pt-5 pb-3">
        <div className="flex items-start gap-2.5 rounded-xl bg-accent/10 border border-accent/20 px-3.5 py-3">
          <Sparkles className="h-4 w-4 text-accent shrink-0 mt-0.5" />
          <p className="text-[12px] text-muted-foreground leading-relaxed">
            DuoSpace never analyzes your partner without their own consent, and raw microphone/camera/video data
            never leaves your device by default. Turning something on here doesn't turn on a feature that doesn't
            exist yet — it just records your choice for when it does.
          </p>
        </div>
      </div>

      <div className="px-5 space-y-2">
        <div className="bg-card rounded-2xl border border-border/60 divide-y divide-border/40">
          {loading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            FEATURE_INFO.map(({ feature, label, description }) => {
              const builtYet = FEATURE_CAPABILITIES[feature];
              return (
                <div key={feature} className="flex items-center gap-3 px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className="text-sm font-medium">{label}</p>
                      {!builtYet && (
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70 border border-border/60 rounded-full px-1.5 py-0.5 shrink-0">
                          Not built yet
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-relaxed">{description}</p>
                  </div>
                  <Switch
                    checked={states[feature] ?? false}
                    disabled={pending === feature}
                    onCheckedChange={(v) => toggle(feature, v)}
                    aria-label={`${label} — ${states[feature] ? "on" : "off"}`}
                  />
                </div>
              );
            })
          )}
        </div>

        <button
          type="button"
          onClick={handleExport}
          disabled={exporting || !user}
          className="w-full flex items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 py-3 text-sm font-medium text-foreground disabled:opacity-50"
        >
          {exporting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Download className="h-4 w-4" aria-hidden="true" />}
          Export my consent &amp; AI data
        </button>

        <div className="flex items-start gap-2.5 px-1 pt-2">
          <ShieldOff className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Turning something off here stops any future processing immediately. It doesn't delete anything you
            already have — deleting your own AI-derived data (once any exists) is a separate, explicit action.
          </p>
        </div>
      </div>
    </motion.div>
  );
};

export default PrivacyAISettings;

/**
 * "Help me reply" — the in-chat, zero-typing path to the (existing, tested)
 * response-support engine. Long-press a partner's message → one suggested
 * reply → "Use this reply" puts it in the composer. Nothing is ever sent
 * automatically; nothing is saved. Same safety gate, grounding and
 * multilingual limited mode as the full panel.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { extractCached } from "@/lib/relationship/contextual/extract";
import { replyIntents, type ReplyIntent } from "@/lib/relationship/contextual/present";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { createRelationshipAIService } from "@/lib/relationship/service";
import { buildProductionRelationshipDeps } from "@/lib/relationship/production";
import { detectEmergencyRegion, getLanguageCode, tr } from "@/lib/i18n";
import { grantConsent } from "@/lib/privacy/consent";
import { consumeAiQuota, type AiQuotaResult } from "@/hooks/useAiQuota";
import QuotaBlocked from "@/components/monetization/QuotaBlocked";
import { ConsentFeature } from "@/lib/privacy/consentFeatures";
import type { ResponseSupport, SupportCorrection } from "@/lib/relationship/responsiveness";

interface Props {
  open: boolean;
  userId: string;
  partnerText: string;
  messageId?: string | null;
  messageAt?: string | null;
  onUse: (reply: string) => void;
  onClose: () => void;
}

const CHIPS: { c: SupportCorrection; labelKey: string }[] = [
  { c: "REGENERATE", labelKey: "p1.reply.chip.another" },
  { c: "MAKE_CLEARER", labelKey: "p1.reply.chip.shorter" },
  { c: "NOT_WHAT_I_MEANT", labelKey: "p1.reply.chip.askFirst" },
  { c: "TOO_FORMAL", labelKey: "p1.reply.chip.moreCasual" },
];

type State = { kind: "loading" } | { kind: "consent" } | { kind: "error" } | { kind: "quota"; q: AiQuotaResult } | { kind: "ready"; s: ResponseSupport };

export default function QuickReplySheet({ open, userId, partnerText, messageId, messageAt, onUse, onClose }: Props) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [corr, setCorr] = useState<SupportCorrection[]>([]);
  const [intent, setIntent] = useState<ReplyIntent["id"]>("ACK");
  // Grounded facts from the selected message only (instant, cached, local).
  // Not computed while consent is missing (the message is not processed at all).
  const noConsent = state.kind === "consent";
  const facts = useMemo(() => extractCached({ id: messageId ?? "selected", text: noConsent ? "" : partnerText }), [messageId, partnerText, noConsent]);
  const { intents, fallback } = useMemo(() => replyIntents(facts), [facts]);

  const run = useCallback(async (corrections: SupportCorrection[], chosen: ReplyIntent["id"] = "ACK") => {
    setState({ kind: "loading" });
    setIntent(chosen);
    // Intent → existing engine option (no new generation logic).
    const withIntent: SupportCorrection[] = chosen === "ASK_FIRST" ? [...corrections, "NOT_WHAT_I_MEANT"] : corrections;
    try {
      const svc = createRelationshipAIService({ deps: buildProductionRelationshipDeps() });
      const r = await svc.supportResponse(userId, { partnerMessage: partnerText, partnerMessageId: messageId ?? null, partnerMessageAt: messageAt ?? null, seeItDifferently: chosen === "EXPLAIN" },
        { corrections: withIntent, language: getLanguageCode(), region: detectEmergencyRegion() });
      // Charge one server-counted AI_STANDARD action only when a real reply is
      // about to be shown. Safety holds / refusals are never metered or hidden.
      const sup = r.support;
      const producesReply = !sup.safetyHold && !sup.refusal && !sup.insufficientInformation && sup.possibleResponse.trim().length > 0;
      if (producesReply) {
        const q = await consumeAiQuota("AI_STANDARD");
        if (!q.allowed) { setState({ kind: "quota", q }); return; }
      }
      setCorr(corrections);
      setState({ kind: "ready", s: r.support });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      setState(code === "CONSENT_MISSING" ? { kind: "consent" } : { kind: "error" });
    }
  }, [userId, partnerText, messageId, messageAt]);

  useEffect(() => { if (open && partnerText.trim()) void run([], facts.confidence === "NONE" ? "ASK_FIRST" : "ACK"); }, [open, partnerText, run, facts.confidence]);

  const s = state.kind === "ready" ? state.s : null;
  const usable = s && !s.safetyHold && !s.refusal && !s.insufficientInformation && s.possibleResponse.trim().length > 0;

  return (
    <Drawer open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DrawerContent className="px-4 pb-6">
        <DrawerHeader className="px-0 text-left">
          <DrawerTitle className="text-base">{tr("p1.ai.helpReply")}</DrawerTitle>
          <DrawerDescription className="text-xs line-clamp-2">“{partnerText}”</DrawerDescription>
        </DrawerHeader>

        {fallback && state.kind !== "consent" && <p className="text-xs text-muted-foreground pb-2">{fallback}</p>}
        {state.kind !== "consent" && intents.length > 1 && (
          <div className="flex gap-1.5 pb-3">
            {intents.map((i) => (
              <button key={i.id} onClick={() => void run([], i.id)} aria-pressed={intent === i.id}
                className={`rounded-full border px-3 py-1 text-xs ${intent === i.id ? "border-primary bg-primary/10" : "border-border/60"}`}>{i.label}</button>
            ))}
          </div>
        )}
        {state.kind === "loading" && <div className="h-16 rounded-2xl bg-muted/30 animate-pulse" aria-label={tr("p1.reply.preparing")} />}

        {state.kind === "consent" && (
          <div className="space-y-3 py-2">
            <p className="text-sm">{tr("p1.reply.consentBody")}</p>
            <Button className="w-full" onClick={async () => { await grantConsent(userId, ConsentFeature.RELATIONSHIP_INSIGHTS, "quick_reply"); void run([], intent); }}>{tr("p1.ai.allowOnDevice")}</Button>
          </div>
        )}

        {state.kind === "quota" && <QuotaBlocked quota={state.q} onNavigate={onClose} />}

        {state.kind === "error" && <p className="text-sm text-muted-foreground py-6 text-center">{tr("p1.reply.error")}</p>}

        {s && s.safetyHold && (
          <div className="rounded-xl bg-muted/40 p-3 space-y-1">{s.notes.map((n) => <p key={n} className="text-xs">{n}</p>)}</div>
        )}

        {s && usable && (
          <div className="space-y-3">
            <div className="rounded-2xl border border-border/60 bg-card p-4">
              <p className="text-[15px] leading-relaxed">{s.possibleResponse}</p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {CHIPS.map(({ c, labelKey }) => (
                <button key={c} onClick={() => void run([...corr, c], intent)} className="rounded-full border border-border/60 px-3 py-1 text-xs">{tr(labelKey)}</button>
              ))}
            </div>
            <Button className="w-full" onClick={() => { onUse(s.possibleResponse); onClose(); }}>{tr("p1.reply.use")}</Button>
            <p className="text-[11px] text-muted-foreground">
              {s.limitedMode ? `${s.notes[0] ?? ""} ` : ""}{tr("p1.reply.footer")}
            </p>
          </div>
        )}

        {s && !usable && !s.safetyHold && (
          <p className="text-sm text-muted-foreground py-4">{s.refusal ?? tr("p1.reply.askDirect")} {s.clarifyingQuestion}</p>
        )}
      </DrawerContent>
    </Drawer>
  );
}

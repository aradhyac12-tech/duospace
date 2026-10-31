/**
 * "Help me reply" — the in-chat, zero-typing path to the (existing, tested)
 * response-support engine. Long-press a partner's message → one suggested
 * reply → "Use this reply" puts it in the composer. Nothing is ever sent
 * automatically; nothing is saved. Same safety gate, grounding and
 * multilingual limited mode as the full panel.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { extractCached } from "@/lib/relationship/contextual/extract";
import { replyIntents, type ReplyIntent } from "@/lib/relationship/contextual/present";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { requestCloudReply, type ContextMessage, type ReplySource } from "@/lib/relationship/contextual/cloudReply";
import { createRelationshipAIService } from "@/lib/relationship/service";
import { buildProductionRelationshipDeps } from "@/lib/relationship/production";
import { detectEmergencyRegion, getLanguageCode, tr } from "@/lib/i18n";
import { grantConsent, hasConsent } from "@/lib/privacy/consent";
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
  /** At most the last few messages around the selected one (the sheet trims further). */
  recent?: ContextMessage[];
  onUse: (reply: string) => void;
  onClose: () => void;
}

const CHIPS: { c: SupportCorrection; labelKey: string }[] = [
  { c: "REGENERATE", labelKey: "p1.reply.chip.another" },
  { c: "MAKE_CLEARER", labelKey: "p1.reply.chip.shorter" },
  { c: "TOO_FORMAL", labelKey: "p1.reply.chip.moreCasual" }, // "Ask first" lives in the intent row
];

type Notice = "NONE" | "QUOTA" | "UNAVAILABLE" | "INSUFFICIENT";
type State = { kind: "loading" } | { kind: "consent" } | { kind: "error" } | { kind: "quota"; q: AiQuotaResult } | { kind: "ready"; s: ResponseSupport; source: ReplySource; notice: Notice };

export default function QuickReplySheet({ open, userId, partnerText, messageId, messageAt, recent, onUse, onClose }: Props) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [corr, setCorr] = useState<SupportCorrection[]>([]);
  const [why, setWhy] = useState(false);
  const [intent, setIntent] = useState<ReplyIntent["id"]>("ACK");
  const [cloudOffer, setCloudOffer] = useState(false);
  const [cloudDeclined, setCloudDeclined] = useState(false);
  const declinedRef = useRef(false); // refs, not deps: changing them must NOT re-trigger (and re-charge) a generation
  const recentRef = useRef<ContextMessage[] | undefined>(recent);
  recentRef.current = recent;
  const runToken = useRef(0); // a cancelled/superseded run must never overwrite the screen
  // Grounded facts from the selected message only (instant, cached, local).
  // Not computed while consent is missing (the message is not processed at all).
  const noConsent = state.kind === "consent";
  const facts = useMemo(() => extractCached({ id: messageId ?? "selected", text: noConsent ? "" : partnerText }), [messageId, partnerText, noConsent]);
  const { intents, fallback } = useMemo(() => replyIntents(facts), [facts]);

  const run = useCallback(async (corrections: SupportCorrection[], chosen: ReplyIntent["id"] = "ACK") => {
    const token = ++runToken.current;
    setState({ kind: "loading" });
    setWhy(false);
    setIntent(chosen);
    // Intent → existing engine option (no new generation logic).
    const withIntent: SupportCorrection[] = chosen === "ASK_FIRST" ? [...corrections, "NOT_WHAT_I_MEANT"] : corrections;
    try {
      const svc = createRelationshipAIService({ deps: buildProductionRelationshipDeps() });
      const r = await svc.supportResponse(userId, { partnerMessage: partnerText, partnerMessageId: messageId ?? null, partnerMessageAt: messageAt ?? null, seeItDifferently: chosen === "EXPLAIN" },
        { corrections: withIntent, language: getLanguageCode(), region: detectEmergencyRegion() });
      // Charge one server-counted AI_STANDARD action only when a model actually
      // worded the reply. The deterministic, rule-based reply is local and free.
      // Safety holds / refusals are never metered or hidden.
      const sup = r.support;
      const producesReply = !sup.safetyHold && !sup.refusal && !sup.insufficientInformation && sup.possibleResponse.trim().length > 0;
      if (token !== runToken.current) return;
      if (producesReply && r.usedModel) {
        // On-device model path only. The CLOUD path below is charged once, server-side, by the gateway.
        const q = await consumeAiQuota("AI_STANDARD");
        if (!q.allowed) { setState({ kind: "quota", q }); return; }
      }
      setCorr(corrections);
      // Safety holds / refusals / insufficient information NEVER go to a cloud model.
      // If the on-device model already produced (and was charged for) this reply, never ALSO call the cloud.
      if (!producesReply || r.usedModel) { setState({ kind: "ready", s: sup, source: "ON_DEVICE_RULES", notice: "NONE" }); return; }
      const cloud = await requestCloudReply({ partnerText, recent: recentRef.current, intent: chosen, corrections, language: getLanguageCode() }, { userId, hasConsent: (u, f) => hasConsent(u, f as ConsentFeature) });
      if (token !== runToken.current) return; // cancelled: result ignored (the server call itself may still finish)
      if (cloud.ok) {
        setCloudOffer(false);
        setState({ kind: "ready", s: { ...sup, possibleResponse: cloud.text }, source: "CLOUD_MODEL", notice: "NONE" });
        return;
      }
      if (cloud.reason === "NO_CONSENT") setCloudOffer(!declinedRef.current);
      const notice: Notice = cloud.reason === "QUOTA" || cloud.reason === "NOT_IN_PLAN" ? "QUOTA" : cloud.reason === "INSUFFICIENT_CONTEXT" ? "INSUFFICIENT" : cloud.reason === "NO_CONSENT" ? "NONE" : "UNAVAILABLE";
      // Honest fallback: the on-device reply is shown and labelled as on-device, never as AI-written.
      setState({ kind: "ready", s: sup, source: "ON_DEVICE_RULES", notice });
    } catch (err) {
      if (token !== runToken.current) return;
      const code = (err as { code?: string })?.code;
      setState(code === "CONSENT_MISSING" ? { kind: "consent" } : { kind: "error" });
    }
  }, [userId, partnerText, messageId, messageAt]);

  // Auto-generate ONCE per opened message. `facts.confidence` can change after the first run (it is
  // recomputed when consent state flips), and re-running would trigger a second cloud generation + charge.
  const autoKey = useRef("");
  useEffect(() => {
    // Closing invalidates any in-flight run so a late result cannot update the sheet (the provider call itself is NOT cancelled).
    if (!open) { autoKey.current = ""; runToken.current++; return; }
    const key = `${messageId ?? ""}|${partnerText}`;
    if (!partnerText.trim() || autoKey.current === key) return;
    autoKey.current = key;
    void run([], facts.confidence === "NONE" ? "ASK_FIRST" : "ACK");
  }, [open, partnerText, messageId, run, facts.confidence]);

  const s = state.kind === "ready" ? state.s : null;
  const source = state.kind === "ready" ? state.source : null;
  const notice = state.kind === "ready" ? state.notice : "NONE";
  const usable = s && !s.safetyHold && !s.refusal && !s.insufficientInformation && s.possibleResponse.trim().length > 0;

  // Intent options sit BELOW the draft (hierarchy: message → draft → source → options → controls → action).
  const intentRow = intents.length > 1 ? (
    <div className="flex flex-wrap gap-2" role="group">
      {intents.map((i) => (
        <button key={i.id} onClick={() => void run([], i.id)} aria-pressed={intent === i.id}
          className={`min-h-9 rounded-full px-3.5 py-1.5 text-xs break-words max-w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${intent === i.id ? "bg-primary/15 text-foreground ring-1 ring-primary/50" : "bg-muted/40 text-muted-foreground"}`}>{i.label}</button>
      ))}
    </div>
  ) : null;

  return (
    <Drawer open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DrawerContent className="px-4 pb-6">
        <DrawerHeader className="px-0 text-left">
          <DrawerTitle className="text-base">{tr("p1.ai.helpReply")}</DrawerTitle>
          <DrawerDescription className="text-xs line-clamp-2 break-words">“{partnerText}”</DrawerDescription>
        </DrawerHeader>

        {fallback && state.kind !== "consent" && <p className="text-xs text-muted-foreground pb-2">{fallback}</p>}
        {state.kind === "loading" && (
          <div className="space-y-2">
            <div className="h-16 rounded-2xl bg-muted/30 motion-safe:animate-pulse" role="status" aria-label={tr("p1.reply.preparing")} />
            <button className="text-xs underline text-muted-foreground" onClick={() => { runToken.current++; onClose(); }}>{tr("p1.reply.cancel")}</button>
          </div>
        )}

        {state.kind === "consent" && (
          <div className="space-y-3 py-2">
            <p className="text-sm">{tr("p1.reply.consentBody")}</p>
            <Button className="w-full" onClick={async () => { await grantConsent(userId, ConsentFeature.RELATIONSHIP_INSIGHTS, "quick_reply"); void run([], intent); }}>{tr("p1.ai.allowOnDevice")}</Button>
          </div>
        )}

        {state.kind === "quota" && <QuotaBlocked quota={state.q} onNavigate={onClose} />}

        {state.kind === "error" && (
          <div className="py-4 text-center space-y-2">
            <p className="text-sm text-muted-foreground">{tr("p1.reply.error")}</p>
            <Button size="sm" variant="outline" onClick={() => void run(corr, intent)}>{tr("p1.reply.retry")}</Button>
          </div>
        )}

        {s && s.safetyHold && (
          <div className="rounded-xl bg-muted/40 p-3 space-y-1">{s.notes.map((n) => <p key={n} className="text-xs">{n}</p>)}</div>
        )}

        {s && usable && (
          <div className="space-y-3">
            <div className="rounded-2xl bg-muted/30 px-4 py-3.5">
              <p className="text-[15px] leading-relaxed break-words">{s.possibleResponse}</p>
              <p className="mt-2 text-[11px] text-muted-foreground">{source === "CLOUD_MODEL" ? tr("p1.reply.badge.ai") : tr("p1.reply.badge.device")}</p>
            </div>
            {notice === "QUOTA" && <p className="text-xs text-muted-foreground">{tr("p1.reply.notice.quota")}</p>}
            {notice === "UNAVAILABLE" && <p className="text-xs text-muted-foreground">{tr("p1.reply.notice.unavailable")}</p>}
            {cloudOffer && !cloudDeclined && (
              <div className="border-t border-border/40 pt-3 space-y-2">
                <p className="text-xs font-medium">{tr("p1.reply.cloud.title")}</p>
                <p className="text-xs text-muted-foreground">{tr("p1.reply.cloud.body")}</p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={async () => { await grantConsent(userId, ConsentFeature.CLOUD_AI_PROCESSING, "quick_reply"); await grantConsent(userId, ConsentFeature.RELATIONSHIP_INSIGHTS, "quick_reply"); void run(corr, intent); }}>{tr("p1.reply.cloud.allow")}</Button>
                  <Button size="sm" variant="ghost" onClick={() => { declinedRef.current = true; setCloudDeclined(true); setCloudOffer(false); }}>{tr("p1.reply.cloud.decline")}</Button>
                </div>
              </div>
            )}
            {intentRow}
            <div className="flex flex-wrap gap-2">
              {CHIPS.map(({ c, labelKey }) => (
                <button key={c} onClick={() => void run([...corr, c], intent)} className="min-h-9 rounded-full bg-muted/40 px-3.5 py-1.5 text-xs text-muted-foreground max-w-full break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{tr(labelKey)}</button>
              ))}
            </div>
            <Button className="w-full min-h-11" onClick={() => { onUse(s.possibleResponse); onClose(); }}>{tr("p1.reply.use")}</Button>
            <div className="text-[11px] text-muted-foreground">
              <button className="underline" aria-expanded={why} onClick={() => setWhy((w) => !w)}>{why ? tr("p1.ai.hide") : tr("p1.ai.why")}</button>
              {why && <p className="mt-1">{s.limitedMode ? `${s.notes[0] ?? ""} ` : ""}{tr("p1.reply.footer")}</p>}
            </div>
          </div>
        )}

        {s && !usable && !s.safetyHold && (
          <p className="text-sm text-muted-foreground py-4">{s.refusal ?? tr("p1.reply.askDirect")} {s.clarifyingQuestion}</p>
        )}
      </DrawerContent>
    </Drawer>
  );
}

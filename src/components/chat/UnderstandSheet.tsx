/**
 * "Understand" — one card, one grounded statement about what the message
 * EXPLICITLY says (never hidden feelings/intent), optional "Why?" showing the
 * exact words, one primary action. Local only; nothing saved or sent.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { buildProductionRelationshipDeps } from "@/lib/relationship/production";
import { grantConsent } from "@/lib/privacy/consent";
import { consumeAiQuota, type AiQuotaResult } from "@/hooks/useAiQuota";
import QuotaBlocked from "@/components/monetization/QuotaBlocked";
import { ConsentFeature } from "@/lib/privacy/consentFeatures";
import { detectEmergencyRegion, getLanguageCode, tr } from "@/lib/i18n";
import { isRelLang } from "@/lib/relationship/i18n/lang";
import { safetyGuidance } from "@/lib/relationship/repair";
import { understand, offersRepair } from "@/lib/relationship/contextual/present";
import { extractCached } from "@/lib/relationship/contextual/extract";

interface Props { open: boolean; userId: string; messageId: string; text: string; onHelpReply: () => void; onClose: () => void }

export default function UnderstandSheet({ open, userId, messageId, text, onHelpReply, onClose }: Props) {
  const [consent, setConsent] = useState<boolean | null>(null);
  const [why, setWhy] = useState(false);
  const [quota, setQuota] = useState<AiQuotaResult | null>(null);
  const navigate = useNavigate();

  // One server-counted AI_STANDARD action per opened analysis. Safety guidance
  // below is NEVER behind this gate — only the insight content is.
  useEffect(() => {
    if (!open || consent !== true) { setQuota(null); return; }
    let live = true;
    void consumeAiQuota("AI_STANDARD").then((q) => { if (live) setQuota(q); });
    return () => { live = false; };
  }, [open, consent, messageId]);
  const quotaOk = quota?.allowed === true;

  useEffect(() => {
    let live = true;
    buildProductionRelationshipDeps().gate.hasConsent(userId, ConsentFeature.RELATIONSHIP_INSIGHTS).then((c) => { if (live) setConsent(c); }, () => { if (live) setConsent(false); });
    return () => { live = false; };
  }, [userId]);

  // Deterministic and instant — computed only after consent is known to be granted.
  const u = useMemo(() => (consent ? understand({ id: messageId, text }) : null), [consent, messageId, text]);
  const repair = useMemo(() => (consent ? offersRepair(extractCached({ id: messageId, text })) : false), [consent, messageId, text]);
  const lang = getLanguageCode();
  const guidance = safetyGuidance(isRelLang(lang) ? lang : "en", detectEmergencyRegion());
  const openRepair = (mode: "own" | "explain" | "boundary" | "walk") => { onClose(); navigate("/reflection", { state: { repair: { partnerSaid: text, mode } } }); };

  return (
    <Drawer open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DrawerContent className="px-4 pb-6">
        <DrawerHeader className="px-0 text-left"><DrawerTitle className="text-base">{tr("p1.understand.title")}</DrawerTitle></DrawerHeader>

        {consent === false && (
          <div className="space-y-3">
            <p className="text-sm">{tr("p1.understand.consentBody")}</p>
            <Button className="w-full" onClick={async () => { await grantConsent(userId, ConsentFeature.RELATIONSHIP_INSIGHTS, "understand"); setConsent(true); }}>{tr("p1.ai.allowOnDevice")}</Button>
          </div>
        )}

        {u?.safety && (
          <div className="rounded-xl bg-muted/40 p-3 space-y-1">
            <p className="text-sm font-medium">{guidance.title}</p>
            {guidance.body.map((b) => <p key={b} className="text-xs">{b}</p>)}
          </div>
        )}

        {u && !u.safety && quota && !quotaOk && <QuotaBlocked quota={quota} onNavigate={onClose} />}

        {u && !u.safety && quotaOk && (
          <div className="space-y-3">
            <div className="rounded-2xl border border-border/60 bg-card p-4">
              <p className="text-[15px] leading-relaxed">{u.statement}</p>
              {u.why.length > 0 && (
                <button className="mt-2 text-[11px] text-muted-foreground underline" onClick={() => setWhy((w) => !w)}>{why ? tr("p1.ai.hide") : tr("p1.ai.why")}</button>
              )}
              {why && <p className="mt-1 text-[11px] text-muted-foreground">{u.why.map((w) => `“${w}”`).join(", ")} — {tr("p1.ai.basedOn")}</p>}
            </div>
            {/* Unclear message → the one action is to ask (QuickReply opens in ask-first mode). */}
            <Button className="w-full" onClick={() => { onClose(); onHelpReply(); }}>{u.why.length ? tr("p1.ai.helpReply") : tr("p1.ai.askThem")}</Button>
            {repair && (
              <div className="space-y-1.5">
                <p className="text-[11px] text-muted-foreground">{tr("p1.understand.repairPrompt")}</p>
                <div className="flex flex-wrap gap-1.5">
                  <button className="rounded-full border border-border/60 px-3 py-1 text-xs" onClick={() => openRepair("own")}>{tr("p1.understand.repair.own")}</button>
                  <button className="rounded-full border border-border/60 px-3 py-1 text-xs" onClick={() => openRepair("explain")}>{tr("p1.understand.repair.explain")}</button>
                  <button className="rounded-full border border-border/60 px-3 py-1 text-xs" onClick={() => openRepair("boundary")}>{tr("p1.understand.repair.boundary")}</button>
                  <button className="rounded-full px-3 py-1 text-xs text-muted-foreground underline" onClick={() => openRepair("walk")}>{tr("p1.understand.repair.walk")}</button>
                </div>
              </div>
            )}
            <p className="text-[10px] text-muted-foreground">{tr("p1.understand.footer")}</p>
          </div>
        )}
      </DrawerContent>
    </Drawer>
  );
}

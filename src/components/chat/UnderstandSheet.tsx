/**
 * "Understand" — one card, one grounded statement about what the message
 * EXPLICITLY says (never hidden feelings/intent), optional "Why?" showing the
 * exact words, one primary action. Local only; nothing saved or sent.
 * Fully deterministic (no model, no network) → never consumes AI quota.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { buildProductionRelationshipDeps } from "@/lib/relationship/production";
import { grantConsent } from "@/lib/privacy/consent";
import { ConsentFeature } from "@/lib/privacy/consentFeatures";
import { detectEmergencyRegion, getLanguageCode, tr } from "@/lib/i18n";
import { isRelLang } from "@/lib/relationship/i18n/lang";
import { safetyGuidance } from "@/lib/relationship/repair";
import { understand, offersRepair } from "@/lib/relationship/contextual/present";
import { extractCached } from "@/lib/relationship/contextual/extract";
import { requestCloudUnderstand, type CloudUnderstandOutcome } from "@/lib/relationship/contextual/cloudUnderstand";
import { hasConsent } from "@/lib/privacy/consent";

interface Props { open: boolean; userId: string; messageId: string; text: string; onHelpReply: () => void; onClose: () => void }

export default function UnderstandSheet({ open, userId, messageId, text, onHelpReply, onClose }: Props) {
  const [consent, setConsent] = useState<boolean | null>(null);
  const [why, setWhy] = useState(false);
  const [cloud, setCloud] = useState<{ kind: "idle" } | { kind: "loading" } | { kind: "done"; r: CloudUnderstandOutcome }>({ kind: "idle" });
  const [cloudAllowed, setCloudAllowed] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    let live = true;
    buildProductionRelationshipDeps().gate.hasConsent(userId, ConsentFeature.RELATIONSHIP_INSIGHTS).then((c) => { if (live) setConsent(c); }, () => { if (live) setConsent(false); });
    return () => { live = false; };
  }, [userId]);

  useEffect(() => {
    let live = true;
    Promise.all([hasConsent(userId, ConsentFeature.CLOUD_AI_PROCESSING), hasConsent(userId, ConsentFeature.RELATIONSHIP_INSIGHTS)]).then(([a, b]) => { if (live) setCloudAllowed(a && b); }, () => {});
    return () => { live = false; };
  }, [userId]);
  const askToken = useRef(0);
  useEffect(() => { askToken.current++; setCloud({ kind: "idle" }); }, [messageId, open]); // switching/closing invalidates a pending look-closer

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

        {u && !u.safety && (
          <div className="space-y-3">
            <div className="rounded-2xl bg-muted/30 px-4 py-3.5">
              <p className="text-[15px] leading-relaxed">{u.statement}</p>
              {u.why.length > 0 && (
                <button className="mt-2 text-[11px] text-muted-foreground underline" onClick={() => setWhy((w) => !w)}>{why ? tr("p1.ai.hide") : tr("p1.ai.why")}</button>
              )}
              {why && <p className="mt-1 text-[11px] text-muted-foreground">{u.why.map((w) => `“${w}”`).join(", ")} — {tr("p1.ai.basedOn")}</p>}
            </div>
            {cloudAllowed && cloud.kind === "idle" && (
              <button className="text-xs underline text-muted-foreground" onClick={async () => { const t = ++askToken.current; setCloud({ kind: "loading" }); const r = await requestCloudUnderstand({ text, language: getLanguageCode() }, { userId, hasConsent: (u, f) => hasConsent(u, f as ConsentFeature) }); if (t === askToken.current) setCloud({ kind: "done", r }); }}>{tr("p1.understand.cloud.ask")}</button>
            )}
            {cloud.kind === "loading" && <div className="h-10 rounded-xl bg-muted/30 motion-safe:animate-pulse" role="status" aria-label={tr("p1.reply.preparing")} />}
            {cloud.kind === "done" && !cloud.r.ok && <p className="text-xs text-muted-foreground">{tr("p1.understand.cloud.failed")}</p>}
            {cloud.kind === "done" && cloud.r.ok && (
              <div className="border-t border-border/40 pt-3 space-y-1">
                <p className="text-[11px] text-muted-foreground">{tr("p1.understand.cloud.label")}</p>
                <p className="text-sm break-words">{cloud.r.summary}</p>
                {(cloud.r.cannotTell || cloud.r.lowConfidence) && <p className="text-xs text-muted-foreground">{tr("p1.understand.cloud.unsure")}</p>}
              </div>
            )}
            {/* Unclear message → the one action is to ask (QuickReply opens in ask-first mode). */}
            <Button className="w-full min-h-11" onClick={() => { onClose(); onHelpReply(); }}>{u.why.length ? tr("p1.ai.helpReply") : tr("p1.ai.askThem")}</Button>
            {repair && (
              <div className="space-y-1.5">
                <p className="text-[11px] text-muted-foreground">{tr("p1.understand.repairPrompt")}</p>
                <div className="flex flex-wrap gap-1.5">
                  <button className="min-h-9 rounded-full bg-muted/40 px-3.5 py-1.5 text-xs text-muted-foreground max-w-full break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => openRepair("own")}>{tr("p1.understand.repair.own")}</button>
                  <button className="min-h-9 rounded-full bg-muted/40 px-3.5 py-1.5 text-xs text-muted-foreground max-w-full break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => openRepair("explain")}>{tr("p1.understand.repair.explain")}</button>
                  <button className="min-h-9 rounded-full bg-muted/40 px-3.5 py-1.5 text-xs text-muted-foreground max-w-full break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => openRepair("boundary")}>{tr("p1.understand.repair.boundary")}</button>
                  <button className="min-h-9 rounded-full px-3.5 py-1.5 text-xs text-muted-foreground underline" onClick={() => openRepair("walk")}>{tr("p1.understand.repair.walk")}</button>
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

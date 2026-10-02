/**
 * Today — at most ONE grounded observation from today's messages already on
 * this device (local decrypted cache; nothing uploaded, nothing new stored —
 * only dismissed message ids). No mood picking, no survey, no streaks.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { tr } from "@/lib/i18n";
import { readLocalChatPage } from "@/lib/chatCache";
import { buildProductionRelationshipDeps } from "@/lib/relationship/production";
import { grantConsent } from "@/lib/privacy/consent";
import { ConsentFeature } from "@/lib/privacy/consentFeatures";
import { selectTodayInsight, type TodayInsight as Insight } from "@/lib/relationship/contextual/present";
import { todayKey } from "@/lib/relationship/checkin";
import QuickReplySheet from "@/components/chat/QuickReplySheet";

const DISMISS_KEY = "rel_today_dismissed_v1";
type Dismissed = { date: string; ids: string[] };

export default function TodayInsight({ userId, partnerId }: { userId: string; partnerId: string | null }) {
  const [state, setState] = useState<"loading" | "consent" | "none" | "ready">("loading");
  const [insight, setInsight] = useState<Insight | null>(null);
  const [text, setText] = useState("");
  const [why, setWhy] = useState(false);
  const [reply, setReply] = useState(false);
  const navigate = useNavigate();

  const load = async () => {
    const deps = buildProductionRelationshipDeps();
    if (!partnerId) { setState("none"); return; }
    if (!(await deps.gate.hasConsent(userId, ConsentFeature.RELATIONSHIP_INSIGHTS))) { setState("consent"); return; }
    const [page, dis] = await Promise.all([readLocalChatPage(userId, partnerId, 200), deps.backend.get<Dismissed>(userId, DISMISS_KEY)]);
    const dismissed = new Set(dis && dis.date === todayKey() ? dis.ids : []);
    const r = selectTodayInsight(page.messages, { me: userId, partner: partnerId, nowMs: Date.now(), dismissed });
    setInsight(r);
    setText(r ? page.messages.find((m) => m.id === r.messageId)?.decryptedContent ?? "" : "");
    setState(r ? "ready" : "none");
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load().catch(() => setState("none")); }, [userId, partnerId]);

  const dismiss = async () => {
    if (!insight) return;
    const deps = buildProductionRelationshipDeps();
    const prev = await deps.backend.get<Dismissed>(userId, DISMISS_KEY);
    const ids = prev && prev.date === todayKey() ? prev.ids : [];
    await deps.backend.set(userId, DISMISS_KEY, { date: todayKey(), ids: [...ids, insight.messageId].slice(-50) });
    setWhy(false);
    await load();
  };

  return (
    <div className="rounded-2xl border border-border/60 bg-card p-4 space-y-3">
      <h2 className="text-sm font-semibold">{tr("p1.today.title")}</h2>
      {state === "loading" && <div className="h-10 rounded-xl bg-muted/30 animate-pulse" />}
      {state === "consent" && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">{tr("p1.today.consentBody")}</p>
          <Button size="sm" variant="secondary" onClick={async () => { await grantConsent(userId, ConsentFeature.RELATIONSHIP_INSIGHTS, "today"); void load(); }}>{tr("p1.ai.allowOnDevice")}</Button>
        </div>
      )}
      {state === "none" && <p className="text-sm text-muted-foreground">{tr("p1.today.empty")}</p>}
      {state === "ready" && insight && (
        <>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{tr("p1.today.notice")}</p>
          <p className="text-[15px] leading-relaxed">{insight.statement}</p>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => setReply(true)}>{tr("p1.ai.helpReply")}</Button>
            <button className="text-[11px] text-muted-foreground underline" onClick={() => setWhy((w) => !w)}>{why ? tr("p1.ai.hide") : tr("p1.ai.why")}</button>
            <button className="ml-auto text-[11px] text-muted-foreground" onClick={() => void dismiss()}>{tr("p1.today.dismiss")}</button>
          </div>
          {why && <p className="text-[11px] text-muted-foreground">“{insight.phrase}” — {tr("p1.ai.basedOn")}</p>}
          <QuickReplySheet open={reply} userId={userId} partnerText={text} messageId={insight.messageId}
            onUse={(r) => navigate("/chat", { state: { draft: r } })} onClose={() => setReply(false)} />
        </>
      )}
    </div>
  );
}

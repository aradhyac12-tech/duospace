/**
 * Phase 3D — minimal relationship-memory surface: four separate consents,
 * what is remembered (current / may be outdated / history), confirm, correct,
 * mark outdated, delete, explicit per-item share, agreements that need both
 * people, and a descriptive summary. No scores, no badges, no rankings.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { tr } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { buildProductionRelationshipDeps } from "@/lib/relationship/production";
import { createRelationshipAIService } from "@/lib/relationship/service";
import { listSharedByMeStrict, listSharedWithMe } from "@/lib/relationship/sharing";
import { changeMemory, reconcileSharedState, withdrawAllMemorySharesVerified } from "@/lib/relationship/memory";
import {
  TOPICS, confirmMemory, correctMemory, createMemory, currency, deleteMemory, markOutdated, setShared, emptyMemoryState,
  partnerMemoriesFromShares, mergeAgreements, agreementStatus, needsReview, REVIEW_QUESTION, topicLabel,
  type Agreement, type MemoryCategory, type MemoryConsents, type MemoryRecord, type MemoryState, type Topic, type LongitudinalSummary,
} from "@/lib/relationship/memory";
import { loadConsents, loadMemory, saveConsents, saveMemory, deleteAllMemory, NO_CONSENT } from "@/lib/relationship/memory/store";
import { previewAgreement, previewAgreementResponse, previewMemoryShare, shareItem, unshareItem } from "@/lib/relationship/memory/share";
import type { ShareRow } from "@/lib/relationship/types";
import type { StoreCtx } from "@/lib/relationship/stores";

const CATS: MemoryCategory[] = ["PREFERENCE", "BOUNDARY", "NEED", "REPAIR_COMMITMENT", "UNRESOLVED_ISSUE", "CHANGE"];
const CAT_LABEL: Record<MemoryCategory, string> = { PREFERENCE: "Preference", BOUNDARY: "Boundary", NEED: "Need", AGREEMENT: "Agreement", REPAIR_COMMITMENT: "Something I'll do", RECURRING_TOPIC: "Topic", POSITIVE_REPAIR_EVENT: "What helped", UNRESOLVED_ISSUE: "Still open", CHANGE: "Something changed" };
const CONSENT_LABEL: Record<keyof MemoryConsents, string> = { store: "Keep my relationship memory on this device", useInAI: "Use my memory when DuoSpace helps me", share: "Let me share individual memories with my partner", longitudinal: "Allow summaries over time" };
const Label = ({ children }: { children: React.ReactNode }) => <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{children}</p>;

export default function MemoryPanel({ userId, partnerId, storeCtx, toast }: { userId: string; partnerId: string | null; storeCtx: StoreCtx; toast: (t: { title: string; description?: string; variant?: "destructive" }) => void }) {
  const deps = buildProductionRelationshipDeps();
  const [consents, setConsents] = useState<MemoryConsents>(NO_CONSENT);
  const [state, setState] = useState<MemoryState>(emptyMemoryState());
  const [rows, setRows] = useState<ShareRow[]>([]);
  const [form, setForm] = useState<{ category: MemoryCategory; topic: Topic; statement: string }>({ category: "PREFERENCE", topic: "planning", statement: "" });
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [agText, setAgText] = useState("");
  const [summary, setSummary] = useState<LongitudinalSummary | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const now = () => Date.now();

  const reload = useCallback(async () => {
    const c = await loadConsents(userId, deps.backend);
    setConsents(c);
    let loaded = c.store ? await loadMemory(userId, deps.backend, now()) : emptyMemoryState();
    if (c.store && loaded.memories.some((m) => m.shareId)) {
      try {
        const r = reconcileSharedState(loaded, await listSharedByMeStrict(userId), userId);
        if (r.changed) { loaded = r.state; await saveMemory(userId, deps.backend, loaded, c); }
      } catch { /* offline: keep local state; never un-share from a failed list */ }
    }
    setState(loaded);
    setRows(await listSharedWithMe(userId).catch(() => []));
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void reload(); }, [reload]);

  // Phase 3E: every write goes through one queue and starts from the LATEST
  // state (not a render-time snapshot), so an action that awaits the network
  // can't overwrite a change made meanwhile (lost update).
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const mutate = (f: (cur: MemoryState) => MemoryState | Promise<MemoryState>): Promise<void> => {
    const job = queue.current.then(async () => {
      const next = await f(stateRef.current);
      await saveMemory(userId, deps.backend, next, consents);
      stateRef.current = next; setState(next);
    });
    queue.current = job.catch(() => undefined);
    return job;
  };
  const run = async (f: () => Promise<void>, ok?: string) => { try { await f(); if (ok) toast({ title: ok }); } catch (e) { toast({ title: tr("p0.error.generic"), description: e instanceof Error ? e.message : undefined, variant: "destructive" }); } };
  const toggle = (k: keyof MemoryConsents) => run(async () => {
    const next = { ...consents, [k]: !consents[k] };
    if ((k === "store" || k === "share") && !next[k]) {
      const w = await withdrawAllMemorySharesVerified(() => listSharedByMeStrict(userId), userId, (id) => unshareItem(userId, id, { store: storeCtx }));
      if (!w.ok) throw new Error(`Couldn't confirm that everything you shared was withdrawn (${w.remaining.length} still shared). Check your connection and try again; nothing else was changed.`);
    }
    await saveConsents(userId, deps.backend, next);
    setConsents(next);
    if (k === "store" && !next.store) { setState(emptyMemoryState()); toast({ title: "Relationship memory deleted from this device" }); }
  });

  const partnerMems = partnerMemoriesFromShares(rows, userId, partnerId, now());
  const agreements = mergeAgreements(state.agreements, rows, userId, partnerId, now());
  const mine = state.memories.filter((m) => m.ownerUserId === userId);
  const groups: [string, MemoryRecord[]][] = [
    ["Current", mine.filter((m) => currency(m, now()) === "CURRENT")],
    ["May be outdated — is this still true?", mine.filter((m) => currency(m, now()) === "MAY_BE_OUTDATED")],
    ["History (no longer current)", mine.filter((m) => ["HISTORICAL", "WITHDRAWN"].includes(currency(m, now())))],
  ];

  return (
    <div className="rounded-2xl border border-border/60 bg-card p-4 space-y-3 text-sm">
      <div>
        <h2 className="text-sm font-semibold">Relationship memory</h2>
        <p className="text-xs text-muted-foreground">Only what you choose to save. Nothing is taken from your chats. Stored encrypted on this device; shared only item by item when you choose. Each setting can be turned off at any time.</p>
      </div>
      <div className="space-y-1.5">
        {(Object.keys(CONSENT_LABEL) as (keyof MemoryConsents)[]).map((k) => (
          <label key={k} className="flex items-center justify-between text-xs"><span>{CONSENT_LABEL[k]}</span><Switch checked={consents[k]} onCheckedChange={() => toggle(k)} /></label>
        ))}
      </div>

      {consents.store && (
        <>
          <div className="space-y-2">
            <Label>Remember something</Label>
            <div className="flex gap-2">
              <select className="flex-1 rounded-md border border-border/60 bg-background px-2 py-1 text-xs" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as MemoryCategory })}>{CATS.map((c) => <option key={c} value={c}>{CAT_LABEL[c]}</option>)}</select>
              <select className="flex-1 rounded-md border border-border/60 bg-background px-2 py-1 text-xs" value={form.topic} onChange={(e) => setForm({ ...form, topic: e.target.value as Topic })}>{TOPICS.map((t) => <option key={t} value={t}>{topicLabel(t)}</option>)}</select>
            </div>
            <Textarea value={form.statement} onChange={(e) => setForm({ ...form, statement: e.target.value })} placeholder="In your own words, e.g. “I prefer advance notice when plans change.”" className="text-sm min-h-[50px]" maxLength={400} />
            <Button size="sm" variant="secondary" className="w-full" disabled={form.statement.trim().length < 3} onClick={() => run(async () => {
              const input = { ownerUserId: userId, relationshipId: partnerId, ...form, sourceType: "USER_ENTERED" as const, sourceId: crypto.randomUUID(), sourceTimestamp: new Date().toISOString() };
              await mutate((cur) => createMemory(cur, input, { nowMs: now(), newId: () => crypto.randomUUID(), consentStore: consents.store }).state); setForm({ ...form, statement: "" });
            }, "Saved")}>Save</Button>
          </div>

          {groups.map(([title, list]) => list.length > 0 && (
            <div key={title} className="space-y-2">
              <Label>{title}</Label>
              {list.map((m) => (
                <div key={m.memoryId} className="rounded-xl border border-border/40 p-3 space-y-1.5">
                  <p className="text-[11px] text-muted-foreground">{CAT_LABEL[m.category]} · {topicLabel(m.topic)} · {m.evidenceLevel === 5 ? "suggested, confirmed by you" : "your words"} · {m.visibility === "SHARED" ? "shared" : "private"}</p>
                  {editing?.id === m.memoryId
                    ? <div className="space-y-1"><Textarea value={editing.text} onChange={(e) => setEditing({ id: m.memoryId, text: e.target.value })} className="text-sm min-h-[44px]" /><Button size="sm" onClick={() => run(async () => { await mutate((cur) => changeMemory(cur, m.memoryId, userId, { kind: "correct", statement: editing.text }, { nowMs: now(), newId: () => crypto.randomUUID(), unshare: (id) => unshareItem(userId, id, { store: storeCtx }) })); setEditing(null); }, "Updated — the old version is kept only as history")}>Save change</Button></div>
                    : <p>{m.statement}</p>}
                  {!m.supersededBy && m.validity === "ACTIVE" && (
                    <div className="flex flex-wrap gap-1.5 text-[11px]">
                      <button className="rounded-full border border-border/60 px-2 py-0.5" onClick={() => run(() => mutate((cur) => confirmMemory(cur, m.memoryId, userId, now())), "Confirmed")}>Still true</button>
                      <button className="rounded-full border border-border/60 px-2 py-0.5" onClick={() => setEditing({ id: m.memoryId, text: m.statement })}>Change / correct</button>
                      <button className="rounded-full border border-border/60 px-2 py-0.5" onClick={() => run(() => mutate((cur) => changeMemory(cur, m.memoryId, userId, { kind: "outdated" }, { nowMs: now(), newId: () => crypto.randomUUID(), unshare: (id) => unshareItem(userId, id, { store: storeCtx }) })), "Marked as no longer true — no longer shared")}>No longer true</button>
                      {consents.share && partnerId && (m.visibility === "SHARED"
                        ? <button className="rounded-full border border-border/60 px-2 py-0.5" onClick={() => run(async () => { if (m.shareId) await unshareItem(userId, m.shareId, { store: storeCtx }); await mutate((cur) => setShared(cur, m.memoryId, userId, null)); }, "Now private")}>Keep private</button>
                        : <button className="rounded-full border border-border/60 px-2 py-0.5" onClick={() => run(async () => { const p = await previewMemoryShare(m, await loadConsents(userId, deps.backend)); if (!window.confirm(`${tr("p0.share.confirm")}\n\n${m.statement}`)) return; const row = await shareItem(userId, p, { gate: deps.gate, store: storeCtx }); /* consent race: if sharing was turned off meanwhile, undo at once */ if (!(await loadConsents(userId, deps.backend)).share) { await unshareItem(userId, row.id, { store: storeCtx }); throw new Error(tr("p0.share.turnedOff")); } await mutate((cur) => setShared(cur, m.memoryId, userId, row.id)); }, "Shared")}>Share with partner</button>)}
                    </div>
                  )}
                  <button className="text-[11px] text-muted-foreground" onClick={() => run(() => mutate((cur) => changeMemory(cur, m.memoryId, userId, { kind: "delete" }, { nowMs: now(), newId: () => crypto.randomUUID(), unshare: (id) => unshareItem(userId, id, { store: storeCtx }) })), "Deleted")}>Delete</button>
                </div>
              ))}
            </div>
          ))}

          {partnerMems.length > 0 && <div className="space-y-1"><Label>Shared with you by your partner (their words)</Label>{partnerMems.map((m) => <p key={m.memoryId} className="text-xs">{topicLabel(m.topic)}: {m.statement}</p>)}</div>}

          <div className="space-y-2">
            <Label>Agreements (only count when you both accept)</Label>
            {agreements.map((a: Agreement) => {
              const st = agreementStatus(a, now());
              const incoming = a.proposedBy !== userId && !a.confirmations[userId];
              return (
                <div key={a.agreementId} className="rounded-xl border border-border/40 p-3 space-y-1">
                  <p>{a.text}</p>
                  <p className="text-[11px] text-muted-foreground">{st === "ACCEPTED_BY_BOTH" ? "Accepted by both" : st === "ACCEPTED_BY_ONE" ? "Waiting for the other person" : st === "DECLINED" ? "Declined" : st.toLowerCase()}</p>
                  {needsReview(a, now()) && <p className="text-xs">{REVIEW_QUESTION}</p>}
                  {incoming && (
                    <div className="flex gap-2">{(["ACCEPTED", "DECLINED"] as const).map((r) => <Button key={r} size="sm" variant="outline" onClick={() => run(async () => { await shareItem(userId, await previewAgreementResponse(a.agreementId, r), { gate: deps.gate, store: storeCtx }); await reload(); }, r === "ACCEPTED" ? "Accepted" : "Declined")}>{r === "ACCEPTED" ? "Accept" : "Decline"}</Button>)}</div>
                  )}
                </div>
              );
            })}
            {partnerId && consents.share && (
              <div className="space-y-1">
                <Textarea value={agText} onChange={(e) => setAgText(e.target.value)} placeholder="Propose an agreement, e.g. “We tell each other if plans change by more than 30 minutes.”" className="text-sm min-h-[44px]" maxLength={400} />
                <Button size="sm" variant="outline" disabled={agText.trim().length < 5} onClick={() => run(async () => {
                  const review = new Date(now() + 14 * 86_400_000).toISOString();
                  const a: Agreement = { agreementId: crypto.randomUUID(), topic: "other", text: agText.trim(), proposedBy: userId, participants: [userId, partnerId], createdAt: new Date().toISOString(), reviewDate: review, confirmations: { [userId]: "ACCEPTED" }, status: "PROPOSED", shareId: null };
                  if (!window.confirm(`Send this proposal to your partner?\n\n${a.text}\n\nIt only becomes an agreement if they accept.`)) return;
                  const row = await shareItem(userId, await previewAgreement(a), { gate: deps.gate, store: storeCtx });
                  await mutate((cur) => ({ ...cur, agreements: [...cur.agreements, { ...a, shareId: row.id }] })); setAgText("");
                }, "Proposed — it becomes an agreement only if your partner accepts")}>Propose (review in 2 weeks)</Button>
              </div>
            )}
          </div>

          {consents.longitudinal && (
            <div className="space-y-2">
              <Button size="sm" variant="secondary" className="w-full" onClick={() => run(async () => {
                const out = await createRelationshipAIService({ deps }).longitudinalSummary({ userId, partnerId, state, partnerShared: partnerMems, consents, windowDays: 30 });
                setSummary(out.summary); setRefusal(out.refused);
              })}>Summary of the last 30 days</Button>
              {refusal && <p className="text-xs text-muted-foreground">{refusal}</p>}
              {summary && (
                <div className="space-y-1">
                  {summary.sentences.map((x, i) => <p key={i} className={x.kind === "UNKNOWN" ? "text-xs text-muted-foreground" : "text-xs"}>{x.text}</p>)}
                  {summary.uncertainty.map((u) => <p key={u} className="text-[11px] text-muted-foreground">{u}</p>)}
                </div>
              )}
            </div>
          )}
          <button className="text-[11px] text-muted-foreground" onClick={() => { if (window.confirm(tr("p0.memory.deleteAllConfirm"))) void run(async () => { const w = await withdrawAllMemorySharesVerified(() => listSharedByMeStrict(userId), userId, (id) => unshareItem(userId, id, { store: storeCtx })); if (!w.ok) throw new Error(tr("p0.memory.withdrawFailed")); await queue.current; await deleteAllMemory(userId, deps.backend); setState(emptyMemoryState()); }, "Relationship memory deleted, and anything you had shared was withdrawn"); }}>Delete all relationship memory</button>
        </>
      )}
    </div>
  );
}

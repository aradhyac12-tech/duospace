/**
 * Phase 3A — deterministic comparison. No model is involved here: this is
 * the source of truth that any explanation layer (rule or local model) only
 * explains.
 *
 * Authorization rule (docs/PHASE_3A_DYADIC_AI_FINAL_REPORT.md §Privacy):
 *  - PARTNER items come ONLY from relationship_shares rows the partner
 *    explicitly created for this user (RLS: recipient_id = auth.uid(),
 *    revoked_at IS NULL). Anything the partner kept private never reaches
 *    this module.
 *  - SELF items come from the user's own on-device store. They are compared
 *    and rendered only on the user's own device; nothing computed here is
 *    uploaded or shared. Sharing a comparison is not implemented.
 */
import type { ShareRow, ValueAnswer, ValuesRecord, Expectation, ValueCategory } from "../types";
import { AnswerMode } from "../types";
import { getQuestion, optionLabel } from "../questions";
import type { ComparisonStatus, DyadicComparison, DyadicCorrection, DyadicItem, StalenessInfo, UnknownReason } from "./types";

/** Options that mean "it depends / flexible / unsure" — too ambiguous to call aligned or different. */
export const AMBIGUOUS_OPTION_IDS: ReadonlySet<string> = new Set(["flex", "depends", "varies", "mix", "mixed", "unsure"]);

/** An answer older than this, or two answers given this far apart, is flagged for clarification. */
export const STALE_AFTER_DAYS = 180;
export const MAX_GAP_DAYS = 90;

const DAY = 86_400_000;

// ── evidence extraction ────────────────────────────────────────────────────

export function selfItemsFromValues(record: ValuesRecord, sharedKeys: ReadonlySet<string> = new Set()): DyadicItem[] {
  return record.answers.map((a: ValueAnswer): DyadicItem => {
    const q = getQuestion(a.questionId);
    const state = a.mode === AnswerMode.ANSWERED ? "ANSWERED" : a.mode === AnswerMode.NOT_SURE ? "NOT_SURE" : "DECLINED";
    return {
      kind: "VALUE_ANSWER",
      key: a.questionId,
      category: a.category,
      prompt: q?.prompt ?? null,
      state,
      choiceId: state === "ANSWERED" ? a.choiceId : null,
      statement: state === "ANSWERED" ? optionLabel(a.questionId, a.choiceId) ?? null : null,
      context: null,
      provenance: {
        source: "user_self_report", owner: "SELF",
        sharedWithPartner: sharedKeys.has(a.questionId) || a.visibility === "SHARED_WITH_PARTNER",
        shareId: a.shareId, confidence: "explicit", createdAt: a.createdAt, updatedAt: a.updatedAt,
      },
    };
  });
}

export function selfItemsFromExpectations(items: Expectation[]): DyadicItem[] {
  const byCat = new Map<ValueCategory, Expectation[]>();
  for (const e of items) if (e.status === "ACTIVE") byCat.set(e.category, [...(byCat.get(e.category) ?? []), e]);
  return [...byCat.entries()].map(([category, list]) => {
    const latest = list.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b));
    return {
      kind: "EXPECTATION" as const, key: `exp:${category}`, category, prompt: null, state: "ANSWERED" as const,
      choiceId: null, statement: list.map((e) => e.statement).join("; "), context: null,
      provenance: {
        source: "user_self_report" as const, owner: "SELF" as const,
        sharedWithPartner: list.some((e) => e.visibility === "SHARED_WITH_PARTNER"), shareId: null,
        confidence: "explicit" as const, createdAt: list[0].createdAt, updatedAt: latest.updatedAt,
      },
    };
  });
}

/**
 * Partner items — ONLY from active share rows addressed to this user.
 * A row from anyone other than `partnerId`, a revoked row, or an expired row
 * is dropped (defence in depth on top of RLS).
 */
export function partnerItemsFromShares(rows: ShareRow[], selfId: string, partnerId: string | null, nowMs: number): DyadicItem[] {
  if (!partnerId) return [];
  const live = rows.filter((r) =>
    r.recipientId === selfId && r.ownerId === partnerId && !r.revokedAt && Date.parse(r.expiresAt) > nowMs);
  const values: DyadicItem[] = [];
  const expByCat = new Map<ValueCategory, ShareRow[]>();
  for (const r of live) {
    const p = r.payload as unknown as Record<string, unknown>;
    if (r.kind === "VALUE_ANSWER" && p.kind === "VALUE_ANSWER") {
      const questionId = String(p.questionId);
      const q = getQuestion(questionId);
      if (!q) continue;
      const answered = p.mode === "ANSWERED" && typeof p.choiceId === "string";
      // Newest share per question wins.
      const prev = values.findIndex((v) => v.key === questionId);
      if (prev >= 0 && values[prev].provenance.updatedAt >= r.createdAt) continue;
      const item: DyadicItem = {
        kind: "VALUE_ANSWER", key: questionId, category: q.category, prompt: q.prompt,
        state: answered ? "ANSWERED" : "NOT_SURE",
        choiceId: answered ? String(p.choiceId) : null,
        statement: answered ? (optionLabel(questionId, String(p.choiceId)) ?? null) : null,
        context: null,
        provenance: { source: "user_self_report", owner: "PARTNER", sharedWithPartner: true, shareId: r.id, confidence: "explicit", createdAt: r.createdAt, updatedAt: r.createdAt },
      };
      if (prev >= 0) values[prev] = item; else values.push(item);
    } else if (r.kind === "EXPECTATION" && p.kind === "EXPECTATION" && typeof p.statement === "string") {
      const cat = p.category as ValueCategory;
      expByCat.set(cat, [...(expByCat.get(cat) ?? []), r]);
    }
  }
  const exps: DyadicItem[] = [...expByCat.entries()].map(([category, list]) => {
    const latest = list.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
    return {
      kind: "EXPECTATION", key: `exp:${category}`, category, prompt: null, state: "ANSWERED", choiceId: null,
      statement: list.map((r) => String((r.payload as unknown as { statement: string }).statement)).join("; "),
      context: null,
      provenance: { source: "user_self_report", owner: "PARTNER", sharedWithPartner: true, shareId: latest.id, confidence: "explicit", createdAt: list[0].createdAt, updatedAt: latest.createdAt },
    };
  });
  return [...values, ...exps];
}

// ── comparison ─────────────────────────────────────────────────────────────

export function staleness(self: DyadicItem | null, partner: DyadicItem | null, nowMs: number): StalenessInfo {
  const s = self?.provenance.updatedAt ?? null;
  const p = partner?.provenance.updatedAt ?? null;
  const gapDays = s && p ? Math.round(Math.abs(Date.parse(s) - Date.parse(p)) / DAY) : null;
  const old = (t: string | null) => t !== null && (nowMs - Date.parse(t)) / DAY > STALE_AFTER_DAYS;
  return { selfUpdatedAt: s, partnerUpdatedAt: p, gapDays, needsClarification: old(s) || old(p) || (gapDays !== null && gapDays > MAX_GAP_DAYS) };
}

function decide(self: DyadicItem | null, partner: DyadicItem | null): { status: ComparisonStatus; reason: UnknownReason | null } {
  if (!self) return { status: "UNKNOWN", reason: "SELF_NOT_ANSWERED" };
  if (!partner) return { status: "UNKNOWN", reason: "PARTNER_NOT_SHARED" };
  if (self.state === "DECLINED" || partner.state === "DECLINED") return { status: "UNKNOWN", reason: "DECLINED" };
  if (self.state === "NOT_SURE" || partner.state === "NOT_SURE") return { status: "UNKNOWN", reason: "NOT_SURE" };
  if (self.kind === "EXPECTATION") return { status: "UNKNOWN", reason: "FREE_TEXT_NOT_COMPARABLE" };
  if (!self.choiceId || !partner.choiceId) return { status: "UNKNOWN", reason: "AMBIGUOUS_ANSWER" };
  if (AMBIGUOUS_OPTION_IDS.has(self.choiceId) || AMBIGUOUS_OPTION_IDS.has(partner.choiceId)) return { status: "UNKNOWN", reason: "AMBIGUOUS_ANSWER" };
  return self.choiceId === partner.choiceId ? { status: "ALIGNED", reason: null } : { status: "DIFFERENT", reason: null };
}

/**
 * Active corrections for a key: a correction stops applying once either
 * person's answer was updated after it (the user has since changed the
 * underlying evidence), so a correction never silently outlives what it corrected.
 */
export function activeCorrections(key: string, corrections: DyadicCorrection[], self: DyadicItem | null, partner: DyadicItem | null): DyadicCorrection[] {
  const latestEvidence = [self?.provenance.updatedAt, partner?.provenance.updatedAt].filter(Boolean).sort().pop() ?? "";
  return corrections.filter((c) => c.comparisonKey === key && c.createdAt >= latestEvidence);
}

export function compareDyad(
  selfItems: DyadicItem[], partnerItems: DyadicItem[], corrections: DyadicCorrection[], nowMs: number,
): DyadicComparison[] {
  const keys = new Set([...selfItems.map((i) => i.key), ...partnerItems.map((i) => i.key)]);
  const out: DyadicComparison[] = [];
  for (const key of keys) {
    let self = selfItems.find((i) => i.key === key) ?? null;
    const partner = partnerItems.find((i) => i.key === key) ?? null;
    const any = self ?? partner!;
    const corr = activeCorrections(key, corrections, self, partner);
    if (corr.some((c) => c.kind === "DONT_SHARE")) self = null; // user withdrew their side from comparison
    const ctxNote = [...corr].reverse().find((c) => (c.kind === "ADD_CONTEXT" || c.kind === "NOT_WHAT_I_MEANT") && c.note)?.note ?? null;
    if (self && ctxNote) self = { ...self, context: ctxNote };
    let { status, reason } = decide(self, partner);
    // Corrections override the deterministic result — never the other way round.
    if (corr.some((c) => c.kind === "OUTDATED")) { status = "UNKNOWN"; reason = "MARKED_OUTDATED"; }
    else if (corr.some((c) => c.kind === "COMPARISON_WRONG" || c.kind === "NOT_WHAT_I_MEANT")) { status = "UNKNOWN"; reason = "MARKED_WRONG"; }
    out.push({ key, kind: any.kind, category: any.category, prompt: any.prompt, status, unknownReason: status === "UNKNOWN" ? reason : null, self, partner, staleness: staleness(self, partner, nowMs) });
  }
  const order: Record<ComparisonStatus, number> = { DIFFERENT: 0, ALIGNED: 1, UNKNOWN: 2 };
  return out.sort((a, b) => order[a.status] - order[b.status] || a.key.localeCompare(b.key));
}

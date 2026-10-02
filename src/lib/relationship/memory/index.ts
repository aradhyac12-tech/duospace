/**
 * Phase 3D — longitudinal relationship memory: public API.
 * UI → RelationshipAIService.longitudinalSummary → summarize/validate here.
 * Core files (types, model, longitudinal, sync, index) make no network,
 * telemetry or logging calls; store.ts uses the encrypted local backend;
 * share.ts is the only network path.
 */
import { LONGITUDINAL_REFUSAL, REFUSAL_TEXT, summarize, validateSummary, type LongIssue, type LongitudinalSummary } from "./longitudinal";
import type { MemoryConsents, MemoryRecord, MemoryState, RepairHistoryEntry, RepairOutcome, Topic, WhatHelped } from "./types";

export * from "./types";
export * from "./model";
export { compareTopics, summarize, validateSummary, selectContext, agreementStatus, needsReview, REVIEW_QUESTION, topicLabel, LONGITUDINAL_REFUSAL, REFUSAL_TEXT } from "./longitudinal";
export type { TopicComparison, LongitudinalSummary, SummarySentence, LongIssue, LongStatus } from "./longitudinal";
export { partnerMemoriesFromShares, mergeAgreements } from "./sync";

/** Explicit, optional post-repair feedback. Nothing is inferred from message timing, replies or app opens. */
export function recordRepairFeedback(state: MemoryState, e: {
  repairId: string; topic: Topic; date: string; userGoal?: string | null; agreedAction?: string | null;
  userOutcome: RepairOutcome | null; whatHelped?: WhatHelped[]; issueOpen?: boolean | null; completion?: RepairHistoryEntry["completion"];
}, consents: MemoryConsents): MemoryState {
  if (!consents.store) throw new Error("memory storage consent not given");
  const entry: RepairHistoryEntry = {
    repairId: e.repairId, topic: e.topic, date: e.date, userGoal: e.userGoal ?? null, agreedAction: e.agreedAction ?? null,
    completion: e.completion ?? "UNKNOWN", userOutcome: e.userOutcome, whatHelped: e.whatHelped ?? [], partnerOutcome: null,
    agreementChanged: false, issueOpen: e.issueOpen ?? null,
  };
  return { ...state, repairs: [...state.repairs.filter((r) => r.repairId !== e.repairId), entry] };
}

export interface SummaryOutcome { summary: LongitudinalSummary; issues: LongIssue[]; refused: string | null; usedModel: boolean }
export interface SummaryRephraser { modelVersion: string; rephraseSummary(input: { sentences: string[] }): Promise<unknown> }

export async function buildLongitudinalSummary(
  state: MemoryState, partnerShared: MemoryRecord[],
  o: { me: string; partner: string | null; consents: MemoryConsents; nowMs: number; windowDays?: number; topic?: Topic; request?: string; model?: SummaryRephraser | null; timeoutMs?: number },
): Promise<SummaryOutcome> {
  const base = summarize(state, partnerShared, o);
  if (o.request && LONGITUDINAL_REFUSAL.test(o.request)) return { summary: { ...base, sentences: [], insufficientInformation: true }, issues: [], refused: REFUSAL_TEXT, usedModel: false };
  const known = new Set([...state.memories.map((m) => m.memoryId), ...partnerShared.map((m) => m.memoryId), ...state.agreements.map((a) => a.agreementId), ...state.repairs.map((r) => r.repairId)]);
  const issues = validateSummary(base, known);
  if (issues.length) return { summary: { ...base, sentences: [], insufficientInformation: true, uncertainty: ["DuoSpace couldn't produce a grounded summary from this."] }, issues, refused: null, usedModel: false };
  if (o.model && o.consents.useInAI && base.sentences.length) {
    try {
      const raw = await Promise.race([o.model.rephraseSummary({ sentences: base.sentences.map((s) => s.text) }), new Promise((_, r) => setTimeout(() => r(new Error("timeout")), o.timeoutMs ?? 8000))]);
      const arr = raw && typeof raw === "object" && Array.isArray((raw as { sentences?: unknown }).sentences) ? (raw as { sentences: unknown[] }).sentences : null;
      if (arr && arr.length === base.sentences.length && arr.every((x) => typeof x === "string" && x.length <= 400)) {
        const cand = { ...base, modelVersion: o.model.modelVersion, sentences: base.sentences.map((s, i) => ({ ...s, text: arr[i] as string })) };
        const mi = validateSummary(cand, known);
        if (mi.length === 0) return { summary: cand, issues, refused: null, usedModel: true };
        issues.push(...mi);
      }
    } catch { /* rule text stands; no cloud */ }
  }
  return { summary: base, issues, refused: null, usedModel: false };
}

// ── Audit fixes (2026-09-25) ────────────────────────────────────────────────
import type { ShareRow } from "../types";
import { correctMemory, deleteMemory, markOutdated } from "./model";

type Unshare = (shareId: string) => Promise<void>;

/**
 * AUDIT FIX D1: changing a SHARED memory used to leave the old statement
 * visible to the partner as if current. Any change (correct / no longer
 * true / delete) now withdraws the share FIRST; if that fails, nothing is
 * changed locally, so the two sides can't silently diverge. The corrected
 * version starts private — sharing it again is a new explicit choice.
 */
export async function changeMemory(
  state: MemoryState, id: string, owner: string,
  change: { kind: "correct"; statement: string } | { kind: "outdated" } | { kind: "delete" },
  ctx: { nowMs: number; newId: () => string; unshare: Unshare },
): Promise<MemoryState> {
  const m = state.memories.find((x) => x.memoryId === id && x.ownerUserId === owner);
  if (m?.shareId) await ctx.unshare(m.shareId);
  const cleared = m?.shareId ? { ...state, memories: state.memories.map((x) => (x.memoryId === id ? { ...x, shareId: null, visibility: "PRIVATE" as const, status: x.status === "SHARED" ? ("USER_APPROVED" as const) : x.status } : x)) } : state;
  if (change.kind === "correct") return correctMemory(cleared, id, owner, { statement: change.statement }, ctx).state;
  if (change.kind === "outdated") return markOutdated(cleared, id, owner);
  return deleteMemory(cleared, id, owner);
}

/** Memory-related share rows this user still has live on the server. */
export function liveMemoryShares(sharedByMe: ShareRow[], me: string): string[] {
  return sharedByMe.filter((r) => r.ownerId === me && !r.revokedAt && (r.kind === "MEMORY" || r.kind === "AGREEMENT" || r.kind === "AGREEMENT_RESPONSE")).map((r) => r.id);
}

/**
 * AUDIT FIX D2: turning off memory storage or sharing, or "Delete all",
 * used to wipe only this device while the partner kept seeing everything
 * already shared. Now every live memory/agreement share is withdrawn too.
 * Returns the ids that could NOT be withdrawn (e.g. offline) so the UI can say so.
 */
export async function withdrawAllMemoryShares(sharedByMe: ShareRow[], me: string, unshare: Unshare): Promise<string[]> {
  const failed: string[] = [];
  for (const id of liveMemoryShares(sharedByMe, me)) { try { await unshare(id); } catch { failed.push(id); } }
  return failed;
}

// ── Phase 3E hardening ──────────────────────────────────────────────────────

/**
 * Consistency repair: a local memory can claim SHARED while the server copy
 * is gone (unlink auto-revokes all shares; withdrawn from elsewhere; a crash
 * between withdraw and local save). Given the owner's CURRENT server rows,
 * mark such memories private again. Only called with a list that loaded
 * successfully — never with a fallback [] (that would wrongly un-share).
 */
export function reconcileSharedState(state: MemoryState, sharedByMe: ShareRow[], me: string): { state: MemoryState; changed: number } {
  const live = new Set(sharedByMe.filter((r) => r.ownerId === me && !r.revokedAt && r.kind === "MEMORY").map((r) => r.id));
  let changed = 0;
  const memories = state.memories.map((m) => {
    if (!m.shareId || live.has(m.shareId)) return m;
    changed++;
    return { ...m, shareId: null, visibility: "PRIVATE" as const, status: m.status === "SHARED" ? ("USER_APPROVED" as const) : m.status };
  });
  return { state: changed ? { ...state, memories } : state, changed };
}

export interface WithdrawResult { ok: boolean; withdrawn: number; remaining: string[] }

/**
 * Withdraw-then-verify. Consistency model (documented, NOT a distributed
 * transaction): 1) list live shares — fails loudly if the list can't load;
 * 2) withdraw each (revoke is idempotent); 3) list AGAIN and confirm none
 * remain (catches a share created concurrently from another device/tab).
 * Callers must only delete local data when ok === true.
 */
export async function withdrawAllMemorySharesVerified(listStrict: () => Promise<ShareRow[]>, me: string, unshare: Unshare): Promise<WithdrawResult> {
  const first = liveMemoryShares(await listStrict(), me);
  const failed = await withdrawAllMemoryShares(first.map((id) => ({ id, ownerId: me, kind: "MEMORY", revokedAt: null } as unknown as ShareRow)), me, unshare);
  const remaining = liveMemoryShares(await listStrict(), me);
  return { ok: failed.length === 0 && remaining.length === 0, withdrawn: first.length - failed.length, remaining };
}

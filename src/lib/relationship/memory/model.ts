/**
 * Phase 3D — pure memory operations and the temporal model.
 *
 * Temporal defaults (documented in .ai/MEMORY_MODEL.md — product defaults,
 * NOT empirically derived, chosen for consistency with earlier phases):
 *  - "May be outdated" after 180 days without confirmation — the same
 *    threshold Phase 3A uses for answers, so the app gives one consistent
 *    rule. The record is NOT deleted; the user is asked "Is this still true?".
 *  - Retention: SHORT_LIVED 90 days (recurring-topic notes, repair feedback —
 *    context for "recent" summaries only); MEDIUM_TERM 365 days (preferences,
 *    needs, unresolved issues — then expire unless re-confirmed); LONG_TERM
 *    no automatic expiry (boundaries, agreements, commitments — the user
 *    decides; staleness prompts still apply). Deletion is always immediate.
 */
import type { EvidenceLevel, MemoryCategory, MemoryRecord, MemoryState, Position, RetentionClass, SourceType, Topic } from "./types";
import { MEMORY_RULE_VERSION, MEMORY_SCHEMA_VERSION } from "./types";

export const STALE_AFTER_DAYS = 180;
const DAY = 86_400_000;
export const RETENTION_DAYS: Record<RetentionClass, number | null> = { SHORT_LIVED: 90, MEDIUM_TERM: 365, LONG_TERM: null };
export const RETENTION_FOR: Record<MemoryCategory, RetentionClass> = {
  PREFERENCE: "MEDIUM_TERM", NEED: "MEDIUM_TERM", UNRESOLVED_ISSUE: "MEDIUM_TERM", CHANGE: "MEDIUM_TERM",
  BOUNDARY: "LONG_TERM", AGREEMENT: "LONG_TERM", REPAIR_COMMITMENT: "LONG_TERM",
  RECURRING_TOPIC: "SHORT_LIVED", POSITIVE_REPAIR_EVENT: "SHORT_LIVED",
};

export class MemoryError extends Error { constructor(public code: "NO_SOURCE" | "EMPTY" | "NOT_FOUND" | "NOT_OWNER" | "CONSENT" | "INVALID" | "HISTORICAL") { super(code); } }

export interface CreateInput {
  ownerUserId: string; relationshipId: string | null; category: MemoryCategory; topic: Topic; statement: string;
  position?: Position | null; sourceType: SourceType; sourceId: string; sourceTimestamp: string;
  /** Only set when the text came from an AI suggestion the user approved; keeps it at level 5. */
  aiSuggested?: boolean;
}

const levelFor = (i: CreateInput): EvidenceLevel =>
  i.aiSuggested ? 5 : i.sourceType === "PARTNER_SHARED" ? 2 : i.sourceType === "AGREEMENT" ? 3 : 1;

export function createMemory(state: MemoryState, i: CreateInput, ctx: { nowMs: number; newId: () => string; consentStore: boolean }): { state: MemoryState; memory: MemoryRecord } {
  if (!ctx.consentStore) throw new MemoryError("CONSENT");
  const statement = i.statement.replace(/\s+/g, " ").trim().slice(0, 400);
  if (!statement) throw new MemoryError("EMPTY");
  if (!i.sourceId || !i.sourceTimestamp || !i.sourceType) throw new MemoryError("NO_SOURCE");
  const now = new Date(ctx.nowMs).toISOString();
  const retention = RETENTION_FOR[i.category];
  const days = RETENTION_DAYS[retention];
  const level = levelFor(i);
  const memory: MemoryRecord = {
    memoryId: ctx.newId(), relationshipId: i.relationshipId, ownerUserId: i.ownerUserId, category: i.category, topic: i.topic,
    statement, position: i.position ?? null, sourceType: i.sourceType, sourceId: i.sourceId, sourceTimestamp: i.sourceTimestamp,
    createdAt: now, lastConfirmedAt: now, expiresAt: days ? new Date(ctx.nowMs + days * DAY).toISOString() : null,
    evidenceLevel: level, confidence: level === 5 ? "INTERPRETED" : level === 2 ? "REPORTED" : "EXPLICIT",
    visibility: "PRIVATE", status: "USER_APPROVED", validity: "ACTIVE", retention,
    supersededBy: null, supersedes: null, shareId: null, modelVersion: MEMORY_RULE_VERSION, schemaVersion: MEMORY_SCHEMA_VERSION,
  };
  return { state: { ...state, memories: [...state.memories, memory] }, memory };
}

function find(state: MemoryState, id: string, owner: string): MemoryRecord {
  const m = state.memories.find((x) => x.memoryId === id);
  if (!m) throw new MemoryError("NOT_FOUND");
  if (m.ownerUserId !== owner) throw new MemoryError("NOT_OWNER");
  return m;
}
const replace = (state: MemoryState, m: MemoryRecord): MemoryState => ({ ...state, memories: state.memories.map((x) => (x.memoryId === m.memoryId ? m : x)) });

/** "Yes, this is still true." Refreshes validity and extends retention from today. */
export function confirmMemory(state: MemoryState, id: string, owner: string, nowMs: number): MemoryState {
  const m = find(state, id, owner);
  if (m.supersededBy || m.status === "DELETED") throw new MemoryError("HISTORICAL");
  const days = RETENTION_DAYS[m.retention];
  return replace(state, { ...m, lastConfirmedAt: new Date(nowMs).toISOString(), validity: "ACTIVE", status: m.status === "EXPIRED" ? "USER_APPROVED" : m.status, expiresAt: days ? new Date(nowMs + days * DAY).toISOString() : null });
}

/**
 * Edit / correct / "that's no longer true, now it's …": the old record becomes
 * historical (CORRECTED, validity CHANGED) and a NEW active record carries the
 * current statement. The old one is never treated as current again.
 */
export function correctMemory(state: MemoryState, id: string, owner: string, patch: { statement: string; position?: Position | null }, ctx: { nowMs: number; newId: () => string }): { state: MemoryState; memory: MemoryRecord } {
  const old = find(state, id, owner);
  if (old.supersededBy || old.status === "DELETED") throw new MemoryError("HISTORICAL");
  const statement = patch.statement.replace(/\s+/g, " ").trim().slice(0, 400);
  if (!statement) throw new MemoryError("EMPTY");
  const now = new Date(ctx.nowMs).toISOString();
  const days = RETENTION_DAYS[old.retention];
  const fresh: MemoryRecord = {
    ...old, memoryId: ctx.newId(), statement, position: patch.position === undefined ? old.position : patch.position,
    sourceType: "USER_ENTERED", sourceId: old.memoryId, sourceTimestamp: now, createdAt: now, lastConfirmedAt: now,
    expiresAt: days ? new Date(ctx.nowMs + days * DAY).toISOString() : null,
    evidenceLevel: 1, confidence: "EXPLICIT", validity: "ACTIVE", status: "USER_APPROVED",
    visibility: "PRIVATE", shareId: null, supersedes: old.memoryId, supersededBy: null,
  };
  const historical: MemoryRecord = { ...old, status: "CORRECTED", validity: "CHANGED", supersededBy: fresh.memoryId };
  return { state: { ...replace(state, historical), memories: [...replace(state, historical).memories, fresh] }, memory: fresh };
}

export function markOutdated(state: MemoryState, id: string, owner: string): MemoryState {
  const m = find(state, id, owner);
  return replace(state, { ...m, validity: "WITHDRAWN" });
}

/** Hard delete: the record (and anything it superseded) is removed, not flagged. */
export function deleteMemory(state: MemoryState, id: string, owner: string): MemoryState {
  find(state, id, owner);
  const chain = new Set([id]);
  let grew = true;
  while (grew) { grew = false; for (const m of state.memories) if ((m.supersededBy && chain.has(m.supersededBy)) && !chain.has(m.memoryId)) { chain.add(m.memoryId); grew = true; } }
  return { ...state, memories: state.memories.filter((m) => !chain.has(m.memoryId)) };
}

export function setShared(state: MemoryState, id: string, owner: string, shareId: string | null): MemoryState {
  const m = find(state, id, owner);
  return replace(state, { ...m, visibility: shareId ? "SHARED" : "PRIVATE", status: shareId ? "SHARED" : "USER_APPROVED", shareId });
}

/** Revoke consent A → wipe all memory (retention policy: user-controlled deletion is immediate). */
export function deleteAll(): MemoryState { return { version: 1, memories: [], agreements: [], repairs: [] }; }

// ── temporal ──────────────────────────────────────────────────────────────

export type Currency = "CURRENT" | "MAY_BE_OUTDATED" | "HISTORICAL" | "WITHDRAWN" | "EXPIRED";

export function currency(m: MemoryRecord, nowMs: number): Currency {
  if (m.supersededBy || m.status === "CORRECTED") return "HISTORICAL";
  if (m.validity === "WITHDRAWN" || m.validity === "CHANGED") return "WITHDRAWN";
  if (m.expiresAt && Date.parse(m.expiresAt) <= nowMs) return "EXPIRED";
  if ((nowMs - Date.parse(m.lastConfirmedAt)) / DAY > STALE_AFTER_DAYS) return "MAY_BE_OUTDATED";
  return "CURRENT";
}

/** Applies retention: expired records are removed (retention is a deletion policy, not a flag). */
export function applyRetention(state: MemoryState, nowMs: number): MemoryState {
  const cutoff = (iso: string, days: number) => (nowMs - Date.parse(iso)) / DAY > days;
  return {
    ...state,
    memories: state.memories.filter((m) => !(m.expiresAt && Date.parse(m.expiresAt) <= nowMs)),
    repairs: state.repairs.filter((r) => !cutoff(r.date, RETENTION_DAYS.MEDIUM_TERM!)),
  };
}

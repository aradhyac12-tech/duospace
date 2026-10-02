/**
 * Phase 3D — encrypted on-device persistence (the same secure backend as all
 * relationship records). Memory is never uploaded; only an explicit share
 * (share.ts) sends a single record's minimal payload.
 */
import type { InsightBackend } from "../../ai/localInsightStore";
import { applyRetention } from "./model";
import { emptyMemoryState, type MemoryConsents, type MemoryState } from "./types";

export const MEMORY_KEY = "rel_memory_v1";
export const MEMORY_CONSENT_KEY = "rel_memory_consents_v1";
export const NO_CONSENT: MemoryConsents = { store: false, useInAI: false, share: false, longitudinal: false };

export async function loadMemory(userId: string, backend: InsightBackend, nowMs: number): Promise<MemoryState> {
  const raw = await backend.get<MemoryState>(userId, MEMORY_KEY);
  const s = raw && raw.version === 1 && Array.isArray(raw.memories) ? raw : emptyMemoryState();
  return applyRetention({ ...s, agreements: s.agreements ?? [], repairs: s.repairs ?? [] }, nowMs);
}
export async function saveMemory(userId: string, backend: InsightBackend, s: MemoryState, consents: MemoryConsents): Promise<void> {
  if (!consents.store) throw new Error("memory storage consent not given");
  await backend.set(userId, MEMORY_KEY, s);
}
/** Deletes relationship memory only — nothing else in the account. */
export async function deleteAllMemory(userId: string, backend: InsightBackend): Promise<void> {
  await backend.remove(userId, MEMORY_KEY);
}
export async function loadConsents(userId: string, backend: InsightBackend): Promise<MemoryConsents> {
  const c = await backend.get<MemoryConsents>(userId, MEMORY_CONSENT_KEY);
  return c ? { ...NO_CONSENT, ...c } : NO_CONSENT;
}
/** Revoking "store" deletes the stored memory immediately (retention policy for revoked consent). */
export async function saveConsents(userId: string, backend: InsightBackend, c: MemoryConsents): Promise<void> {
  const prev = await loadConsents(userId, backend);
  await backend.set(userId, MEMORY_CONSENT_KEY, c);
  if (prev.store && !c.store) await deleteAllMemory(userId, backend);
}

/**
 * Encrypted, device-local persistence for locally-produced insights — the
 * last step of  input -> local processing -> structured output -> validation
 * -> ENCRYPTED LOCAL STORAGE.  See .ai/LOCAL_AI_ARCHITECTURE.md.
 *
 * No Supabase, no network: the default backend is privacy/secureStorage
 * (software AES-256-GCM via Web Crypto; NOT hardware-backed — see that file
 * and .ai/SECURITY_MODEL.md). The backend is injectable so this logic is
 * testable and so a hardware-backed store can replace it later without
 * touching callers.
 *
 * Only insights that already passed validateInsight() + the provenance
 * check may be written; expired insights are dropped on read.
 */
import type { AIInsight } from "./types";
import { validateInsight } from "./outputValidator";
import { checkAIProvenance, LOCAL_PROCESSOR_EXPECTATIONS } from "./provenance";

export interface InsightBackend {
  get<T>(userId: string, key: string): Promise<T | null>;
  set(userId: string, key: string, value: unknown): Promise<void>;
  remove(userId: string, key: string): Promise<void>;
}

const INDEX_KEY = "ai_insight_index_v1";
const itemKey = (id: string) => `ai_insight_${id}`;

async function defaultBackend(): Promise<InsightBackend> {
  // Lazy so importing this module never pulls Capacitor/IndexedDB in tests
  // or non-device contexts.
  const m = await import("@/lib/privacy/secureStorage");
  return { get: m.secureGet, set: m.secureSet, remove: m.secureRemove };
}

async function readIndex(b: InsightBackend, userId: string): Promise<string[]> {
  const idx = await b.get<string[]>(userId, INDEX_KEY);
  return Array.isArray(idx) ? idx.filter((x) => typeof x === "string") : [];
}

export async function saveLocalInsight(userId: string, insight: AIInsight, backend?: InsightBackend): Promise<void> {
  if (!userId || insight.userId !== userId) throw new Error("saveLocalInsight: insight does not belong to this user.");
  if (!insight.id) throw new Error("saveLocalInsight: insight has no id.");
  const validation = validateInsight(insight);
  if (!validation.valid) throw new Error(`saveLocalInsight: failed safety validation: ${validation.issues.map((i) => i.field).join(", ")}`);
  const prov = checkAIProvenance(insight, LOCAL_PROCESSOR_EXPECTATIONS(insight.feature));
  if (prov.length) throw new Error(`saveLocalInsight: failed provenance check: ${prov.map((i) => i.field).join(", ")}`);

  const b = backend ?? (await defaultBackend());
  await b.set(userId, itemKey(insight.id), insight);
  const idx = await readIndex(b, userId);
  if (!idx.includes(insight.id)) await b.set(userId, INDEX_KEY, [...idx, insight.id]);
}

export async function listLocalInsights(userId: string, backend?: InsightBackend, now: Date = new Date()): Promise<AIInsight[]> {
  const b = backend ?? (await defaultBackend());
  const idx = await readIndex(b, userId);
  // BUG FIX (page-wide "everything felt laggy"): this used to `await` one
  // b.get() per insight IN A LOOP — a native Capacitor Preferences call
  // plus a Web Crypto AES-GCM decrypt, back-to-back, one at a time. Every
  // single tap in Reflection (answering a values question, adding/archiving
  // an expectation, rating an insight) calls refreshLocal() -> here, so the
  // whole page's responsiveness degraded linearly with how many insights
  // had ever accumulated — a handful felt fine, a few dozen felt frozen.
  // Fire every read in parallel instead; each one is independent (keyed by
  // its own id), so there's no ordering reason they need to be sequential.
  const items = await Promise.all(idx.map((id) => b.get<AIInsight>(userId, itemKey(id))));
  const out: AIInsight[] = [];
  const keep: string[] = [];
  const expired: string[] = [];
  idx.forEach((id, i) => {
    const item = items[i];
    if (!item) return; // undecryptable/absent: drop from the index
    if (item.expiresAt && Date.parse(item.expiresAt) <= now.getTime()) {
      expired.push(id);
      return;
    }
    out.push(item);
    keep.push(id);
  });
  if (expired.length) await Promise.all(expired.map((id) => b.remove(userId, itemKey(id))));
  if (keep.length !== idx.length) await b.set(userId, INDEX_KEY, keep);
  return out;
}

/**
 * Overwrites an insight already in the store (used by correction.ts — the
 * "user disputed/amended it" path). Re-runs the same safety + provenance
 * checks as saveLocalInsight and refuses to change id/userId/createdAt, so a
 * correction can only touch lifecycle/correction and cannot smuggle a new
 * observation past the validator by pretending to be an "update".
 */
export async function updateLocalInsight(userId: string, insight: AIInsight, backend?: InsightBackend): Promise<void> {
  const b = backend ?? (await defaultBackend());
  const idx = await readIndex(b, userId);
  if (!idx.includes(insight.id)) throw new Error("updateLocalInsight: no existing insight with this id.");
  const existing = await b.get<AIInsight>(userId, itemKey(insight.id));
  if (!existing || existing.userId !== userId || existing.createdAt !== insight.createdAt) {
    throw new Error("updateLocalInsight: refusing to overwrite id/userId/createdAt.");
  }
  const validation = validateInsight(insight);
  if (!validation.valid) throw new Error(`updateLocalInsight: failed safety validation: ${validation.issues.map((i) => i.field).join(", ")}`);
  const prov = checkAIProvenance(insight, LOCAL_PROCESSOR_EXPECTATIONS(insight.feature));
  if (prov.length) throw new Error(`updateLocalInsight: failed provenance check: ${prov.map((i) => i.field).join(", ")}`);
  await b.set(userId, itemKey(insight.id), insight);
}

export async function deleteLocalInsight(userId: string, id: string, backend?: InsightBackend): Promise<void> {
  const b = backend ?? (await defaultBackend());
  await b.remove(userId, itemKey(id));
  const idx = await readIndex(b, userId);
  if (idx.includes(id)) await b.set(userId, INDEX_KEY, idx.filter((x) => x !== id));
}

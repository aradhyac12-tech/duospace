/**
 * Provenance (spec §8, §33). Answers "Why did DuoSpace say this?":
 *   USER EVIDENCE → NORMALIZED OBSERVATION → RULE → KNOWLEDGE CLAIM → RESEARCH SOURCE
 * Log entries are append-only and hash-chained (tamper-EVIDENT, not tamper-proof;
 * the DB additionally blocks UPDATE/DELETE).
 */
import type { KnowledgeSnapshot } from "./snapshot";
import type { InferenceTrace } from "./types";

export interface WhyStep { level: "observation" | "rule" | "claim" | "source"; id: string; label: string }
export interface WhyChain { complete: boolean; steps: WhyStep[]; missing: string[] }

export function explainWhy(t: InferenceTrace, snap: KnowledgeSnapshot): WhyChain {
  const steps: WhyStep[] = []; const missing: string[] = [];
  for (const id of t.observationIds) steps.push({ level: "observation", id, label: "normalized observation" });
  const rule = snap.rules.find((r) => r.ruleKey === t.ruleKey && r.version === t.ruleVersion);
  if (!rule) missing.push(`rule ${t.ruleKey}@${t.ruleVersion}`); else steps.push({ level: "rule", id: rule.ruleKey, label: rule.name });
  if (t.observationIds.length === 0) missing.push("observations");
  for (const ck of t.claimKeys) {
    const c = snap.claims.find((x) => x.claimKey === ck);
    if (!c) { missing.push(`claim ${ck}`); continue; }
    steps.push({ level: "claim", id: c.claimKey, label: c.claimText });
  }
  for (const sk of t.sourceKeys) {
    const s = snap.sources.find((x) => x.sourceKey === sk);
    if (!s) { missing.push(`source ${sk}`); continue; }
    steps.push({ level: "source", id: s.sourceKey, label: `${s.title}${s.publicationYear ? ` (${s.publicationYear})` : ""}` });
  }
  if (rule?.ruleBasis === "evidence_claim" && (t.claimKeys.length === 0 || t.sourceKeys.length === 0)) missing.push("claim/source chain for evidence_claim rule");
  return { complete: missing.length === 0, steps, missing };
}

// 53-bit non-cryptographic string hash (cyrb53). Swap for SHA-256 server-side.
export function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

export interface ProvenanceEntry {
  entityType: string; entityKey: string; action: string; createdBy: string; createdAt: string;
  source: string; version: string; previousVersion: string | null; changeReason: string; prevHash: string; entryHash: string;
}
export function appendProvenance(log: readonly ProvenanceEntry[], e: Omit<ProvenanceEntry, "prevHash" | "entryHash">): ProvenanceEntry[] {
  if (!e.changeReason.trim()) throw new Error("change reason required");
  const prevHash = log.length ? log[log.length - 1].entryHash : "genesis";
  const entryHash = cyrb53(prevHash + JSON.stringify(e));
  return [...log, { ...e, prevHash, entryHash }];
}
export function verifyChain(log: readonly ProvenanceEntry[]): boolean {
  let prev = "genesis";
  for (const { prevHash, entryHash, ...rest } of log) {
    if (prevHash !== prev || cyrb53(prev + JSON.stringify(rest)) !== entryHash) return false;
    prev = entryHash;
  }
  return true;
}

/** Observability record (spec §33): ids and states only — never message text. */
export function inferenceLogRecord(t: InferenceTrace, outputState: string, confidence: string, now: Date) {
  return { rule_id: t.ruleKey, rule_version: t.ruleVersion, knowledge_version: t.knowledgeVersion, evidence_ids: t.observationIds,
    input_state: t.inputState, output_state: outputState, confidence, timestamp: now.toISOString() };
}

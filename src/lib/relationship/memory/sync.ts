/**
 * Phase 3D — turning explicitly shared rows into partner records, and merging
 * agreement confirmations. Pure: takes ShareRow[] already read under RLS.
 */
import type { ShareRow } from "../types";
import type { Agreement, MemoryRecord, Position, Topic } from "./types";
import { MEMORY_RULE_VERSION, MEMORY_SCHEMA_VERSION, TOPICS } from "./types";

const live = (r: ShareRow, me: string, partner: string | null, nowMs: number) =>
  !!partner && r.ownerId === partner && r.recipientId === me && !r.revokedAt && Date.parse(r.expiresAt) > nowMs;

export function partnerMemoriesFromShares(rows: ShareRow[], me: string, partner: string | null, nowMs: number): MemoryRecord[] {
  return rows.filter((r) => r.kind === "MEMORY" && live(r, me, partner, nowMs)).flatMap((r) => {
    const p = r.payload as unknown as { memoryId: string; category: MemoryRecord["category"]; topic: Topic; statement: string; position?: Position | null; lastConfirmedAt: string };
    if (!p.statement || !TOPICS.includes(p.topic)) return [];
    return [{
      memoryId: `shared:${r.id}`, relationshipId: null, ownerUserId: r.ownerId, category: p.category, topic: p.topic, statement: p.statement,
      position: p.position ?? null, sourceType: "PARTNER_SHARED" as const, sourceId: r.id, sourceTimestamp: r.createdAt,
      createdAt: r.createdAt, lastConfirmedAt: p.lastConfirmedAt ?? r.createdAt, expiresAt: r.expiresAt,
      evidenceLevel: 2 as const, confidence: "REPORTED" as const, visibility: "SHARED" as const, status: "SHARED" as const, validity: "ACTIVE" as const,
      retention: "MEDIUM_TERM" as const, supersededBy: null, supersedes: null, shareId: r.id, modelVersion: MEMORY_RULE_VERSION, schemaVersion: MEMORY_SCHEMA_VERSION,
    }];
  });
}

/** Agreements proposed TO me, plus partner responses to agreements I proposed. */
export function mergeAgreements(mine: Agreement[], rows: ShareRow[], me: string, partner: string | null, nowMs: number): Agreement[] {
  const out = new Map(mine.map((a) => [a.agreementId, { ...a, confirmations: { ...a.confirmations } }]));
  for (const r of rows) {
    if (!live(r, me, partner, nowMs)) continue;
    const p = r.payload as unknown as Record<string, string | null>;
    if (r.kind === "AGREEMENT" && p.agreementId && !out.has(p.agreementId)) {
      out.set(p.agreementId, { agreementId: p.agreementId, topic: (p.topic as Topic) ?? "other", text: String(p.text), proposedBy: r.ownerId, participants: [r.ownerId, me], createdAt: r.createdAt, reviewDate: p.reviewDate ?? null, confirmations: { [r.ownerId]: "ACCEPTED" }, status: "PROPOSED", shareId: r.id });
    }
    if (r.kind === "AGREEMENT_RESPONSE" && p.agreementId && out.has(p.agreementId) && (p.response === "ACCEPTED" || p.response === "DECLINED")) {
      out.get(p.agreementId)!.confirmations[r.ownerId] = p.response;
    }
  }
  return [...out.values()];
}

/**
 * Phase 3C — explicit sharing of a user-approved repair message.
 * Uses the existing relationship_shares path (preview → hash → consent gate
 * → partner-only insert under RLS; owner revoke = withdraw). Only the
 * message text is sent; the database rejects any other payload key.
 * This file is the ONLY repair file that touches the network.
 */
import { confirmShare, revokeShare, withHash, type ShareCtx } from "../sharing";
import type { SharePreview, ShareRow } from "../types";
import { RelationshipError } from "../errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function previewRepairShare(sessionId: string, message: string, inReplyTo?: string): Promise<SharePreview> {
  const text = message.trim();
  if (!text || text === "INSUFFICIENT_INFORMATION" || text.length > 2000) throw new RelationshipError("SHARE_DENIED");
  if (inReplyTo !== undefined && !UUID.test(inReplyTo)) throw new RelationshipError("SHARE_DENIED");
  return withHash({
    kind: "REPAIR_MESSAGE", itemRef: sessionId, payloadHash: "",
    payload: inReplyTo ? { v: 1, kind: "REPAIR_MESSAGE", message: text, inReplyTo } : { v: 1, kind: "REPAIR_MESSAGE", message: text },
    lines: [{ label: "Exactly this message will be shared", value: text }, { label: "Not shared", value: "Your answers, notes, any analysis, and safety information stay on this device." }],
  });
}

export const shareRepairMessage = (userId: string, preview: SharePreview, ctx: ShareCtx): Promise<ShareRow> => confirmShare(userId, preview, ctx);
export const withdrawRepairMessage = (userId: string, shareId: string, ctx: Pick<ShareCtx, "store">): Promise<void> => revokeShare(userId, shareId, ctx);

// ── conversation states (pure; derived from RLS-visible rows only) ─────────

export interface RepairThreadItem { id: string; message: string; at: string; inReplyTo: string | null }

const toItem = (r: ShareRow): RepairThreadItem | null => {
  const p = r.payload as { kind?: string; message?: unknown; inReplyTo?: unknown };
  if (r.kind !== "REPAIR_MESSAGE" || p.kind !== "REPAIR_MESSAGE" || typeof p.message !== "string" || !p.message) return null;
  return { id: r.id, message: p.message, at: r.createdAt, inReplyTo: typeof p.inReplyTo === "string" ? p.inReplyTo : null };
};

/**
 * RECEIVED / RESPONDED for messages my partner sent me, and whether my own
 * sent messages got a reply. Uses only rows RLS already lets this user see:
 * received = recipient rows (not revoked, not expired); sent = my own rows.
 * Reading a message is never treated as consent or as a response.
 */
export function deriveRepairThreads(received: ShareRow[], sentByMe: ShareRow[], nowMs: number) {
  const live = (r: ShareRow) => !r.revokedAt && Date.parse(r.expiresAt) > nowMs;
  const inbox = received.filter(live).map(toItem).filter((x): x is RepairThreadItem => !!x);
  const outbox = sentByMe.filter(live).map(toItem).filter((x): x is RepairThreadItem => !!x);
  return {
    receivedMessages: inbox.map((m) => ({ ...m, state: (outbox.some((o) => o.inReplyTo === m.id) ? "RESPONDED" : "RECEIVED") as "RECEIVED" | "RESPONDED" })),
    replyTo: (mySentId: string) => inbox.find((m) => m.inReplyTo === mySentId) ?? null,
  };
}

/**
 * Phase 3D — the ONLY network path for memory: explicit per-item sharing
 * via the existing relationship_shares (preview → hash → consent gate →
 * partner-only insert under RLS; owner revoke = unshare).
 */
import { confirmShare, revokeShare, withHash, type ShareCtx } from "../sharing";
import type { SharePreview } from "../types";
import type { Agreement, MemoryConsents, MemoryRecord } from "./types";
import { topicLabel } from "./longitudinal";
import { checkSafety } from "../repair/machine";

/**
 * AUDIT FIX D4: the same fail-closed safety gate as Conflict Repair (all 12
 * languages). A statement that may involve a safety concern is never sent to
 * the partner from here — sharing it could increase risk. It stays private.
 */
export class MemorySafetyHold extends Error { constructor() { super("This may involve a safety concern, so DuoSpace won't share it with your partner. It stays private on this device."); } }
const assertSafeToShare = (text: string) => { if (checkSafety({ concreteEvent: text }).status !== "CLEAR") throw new MemorySafetyHold(); };

export function previewMemoryShare(m: MemoryRecord, consents: MemoryConsents): Promise<SharePreview> {
  if (!consents.share) throw new Error("memory sharing consent not given");
  if (m.supersededBy || m.validity !== "ACTIVE" || m.evidenceLevel === 5) throw new Error("only a current memory you stated yourself can be shared");
  assertSafeToShare(m.statement);
  return withHash({
    kind: "MEMORY", itemRef: m.memoryId, payloadHash: "",
    payload: { v: 1, kind: "MEMORY", memoryId: m.memoryId, category: m.category, topic: m.topic, statement: m.statement, position: m.position, lastConfirmedAt: m.lastConfirmedAt },
    lines: [{ label: "Topic", value: topicLabel(m.topic) }, { label: "Exactly this will be shared", value: m.statement }, { label: "Not shared", value: "Your other memories, history, summaries and anything DuoSpace generated." }],
  });
}
export const previewAgreement = (a: Agreement) => (assertSafeToShare(a.text), withHash({
  kind: "AGREEMENT", itemRef: a.agreementId, payloadHash: "",
  payload: { v: 1, kind: "AGREEMENT", agreementId: a.agreementId, topic: a.topic, text: a.text, reviewDate: a.reviewDate },
  lines: [{ label: "Proposed agreement", value: a.text }, { label: "Status", value: "It only becomes an agreement if your partner accepts it too." }],
}));
export const previewAgreementResponse = (agreementId: string, response: "ACCEPTED" | "DECLINED") => withHash({
  kind: "AGREEMENT_RESPONSE", itemRef: `${agreementId}:response`, payloadHash: "",
  payload: { v: 1, kind: "AGREEMENT_RESPONSE", agreementId, response }, lines: [{ label: "Your response", value: response === "ACCEPTED" ? "Accept" : "Decline" }],
});
export const shareItem = (userId: string, p: SharePreview, ctx: ShareCtx) => confirmShare(userId, p, ctx);
export const unshareItem = (userId: string, shareId: string, ctx: Pick<ShareCtx, "store">) => revokeShare(userId, shareId, ctx);

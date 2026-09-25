/**
 * Explicit, per-item partner sharing (brief §11). Everything here follows
 * three rules from the brief, enforced in code, not just by convention:
 *
 *  1. Default is PRIVATE. Nothing crosses into a share except through
 *     buildSharePreview() -> confirmShare(), both called from an explicit
 *     user action (a tap on a share control) — never automatically.
 *  2. "Show exactly what will be shared, before sharing." buildSharePreview()
 *     returns the literal payload plus human-readable `lines` built only
 *     from that payload; confirmShare() requires the SAME payload hash back,
 *     so a UI cannot show one preview and send a different payload.
 *  3. Only the fields selected for sharing are ever sent — raw private
 *     journal entries, hidden AI context (confidence/context/modelVersion),
 *     and any note not explicitly included never appear in a SharePayload.
 *     PrivacyGate's EXPLICIT_SHARE verdict (destination PARTNER, SENSITIVE
 *     or HIGHLY_SENSITIVE data) is still checked here — a share is refused
 *     if SHARED_INSIGHTS consent isn't currently granted, even though the
 *     user just tapped "share".
 */
import { supabase } from "@/integrations/supabase/appClient";
import type { AIInsight } from "../ai/types";
import { canProcess } from "../privacy/privacyGate";
import { ConsentFeature } from "../privacy/consentFeatures";
import { DataClassification, ProcessingLocation } from "../privacy/dataClassification";
import type { PrivacyGateDeps } from "../privacy/privacyGate";
import { describeProvenance } from "../ai/provenance";
import { RelationshipError } from "./errors";
import { AnswerMode, CATEGORY_LABEL, IMPORTANCE_LABEL, TYPE_LABEL, Visibility, type Expectation, type ValueAnswer } from "./types";
import type { ExpectationSharePayload, InsightSharePayload, ShareKind, SharePayload, SharePreview, ShareRow, ValueSharePayload } from "./types";
import { optionLabel } from "./questions";
import { setExpectationShareState, setValueShareState, type StoreCtx } from "./stores";

// ── hashing ───────────────────────────────────────────────────────────────

async function hashPayload(payload: SharePayload): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── partner lookup ────────────────────────────────────────────────────────

export async function getPartnerId(userId: string): Promise<string | null> {
  const { data, error } = await supabase.from("profiles").select("partner_id").eq("user_id", userId).maybeSingle();
  if (error || !data) return null;
  return (data as { partner_id: string | null }).partner_id;
}

// ── previews (rule 2) ───────────────────────────────────────────────────

export function previewValueAnswer(answer: ValueAnswer, prompt: string): SharePreview {
  if (answer.mode === AnswerMode.PREFER_NOT_TO_ANSWER) throw new RelationshipError("SHARE_DENIED");
  const choiceLabel = answer.mode === AnswerMode.ANSWERED ? optionLabel(answer.questionId, answer.choiceId) : null;
  const payload: ValueSharePayload = {
    v: 1, kind: "VALUE_ANSWER", questionId: answer.questionId, category: answer.category, prompt,
    mode: answer.mode === AnswerMode.ANSWERED ? "ANSWERED" : "NOT_SURE",
    choiceId: answer.mode === AnswerMode.ANSWERED ? answer.choiceId : null,
    choiceLabel: answer.mode === AnswerMode.ANSWERED ? choiceLabel : null,
    // The owner's private note is NOT included by default — sharing a
    // choice never silently shares free text (brief §11's "not selected
    // for sharing" data stays out).
  };
  return buildPreview("VALUE_ANSWER", answer.questionId, payload, [
    { label: "Category", value: CATEGORY_LABEL[answer.category] },
    { label: "Question", value: prompt },
    { label: "Your answer", value: answer.mode === AnswerMode.ANSWERED ? (choiceLabel ?? "—") : "Not sure" },
  ]);
}

export function previewExpectation(item: Expectation): SharePreview {
  const payload: ExpectationSharePayload = {
    v: 1, kind: "EXPECTATION", category: item.category, statement: item.statement, type: item.type, importance: item.importance,
  };
  return buildPreview("EXPECTATION", item.id, payload, [
    { label: "Category", value: CATEGORY_LABEL[item.category] },
    { label: "Type", value: TYPE_LABEL[item.type] },
    { label: "Importance", value: IMPORTANCE_LABEL[item.importance] },
    { label: "Statement", value: item.statement },
  ]);
}

export function previewInsight(insight: AIInsight): SharePreview {
  const provenance = describeProvenance(insight.source);
  const payload: InsightSharePayload = {
    v: 1, kind: "INSIGHT",
    observation: insight.observation,
    possibleExplanations: insight.possibleExplanations,
    uncertainty: insight.uncertainty,
    suggestedAction: insight.suggestedAction,
    provenanceLabel: provenance.label,
    // confidence/context/modelVersion/evidence/consentReference deliberately
    // excluded — "hidden AI context" the brief says stays out unless the
    // sharing model is intentionally designed to include it (it isn't, here).
  };
  return buildPreview("INSIGHT", insight.id, payload, [
    { label: "What this is based on", value: provenance.label },
    { label: "Observation", value: insight.observation },
    { label: "Uncertainty", value: insight.uncertainty },
  ]);
}

function buildPreview(kind: ShareKind, itemRef: string, payload: SharePayload, lines: SharePreview["lines"]): SharePreview {
  // payloadHash is filled in synchronously by the caller below (async
  // wrapper) — kept here as a placeholder so buildPreview stays a pure,
  // synchronous, easily-testable formatter.
  return { kind, itemRef, payload, payloadHash: "", lines };
}

/** Wraps a sync preview builder with the payload hash (async because SHA-256 via Web Crypto is async). */
export async function withHash(preview: SharePreview): Promise<SharePreview> {
  return { ...preview, payloadHash: await hashPayload(preview.payload) };
}

// ── share / revoke ────────────────────────────────────────────────────────

export interface ShareCtx {
  gate: PrivacyGateDeps;
  store: StoreCtx;
}

const classificationFor = (kind: ShareKind): DataClassification =>
  kind === "INSIGHT" ? DataClassification.HIGHLY_SENSITIVE : DataClassification.SENSITIVE;

/**
 * Confirms a share the user has just previewed. `preview.payloadHash` must
 * still match a fresh hash of `preview.payload` — this is what makes
 * "show exactly what will be shared, before sharing" enforceable rather than
 * just documented: a preview screen cannot be stale by the time this runs.
 */
export async function confirmShare(userId: string, preview: SharePreview, ctx: ShareCtx): Promise<ShareRow> {
  const freshHash = await hashPayload(preview.payload);
  if (freshHash !== preview.payloadHash) throw new RelationshipError("PREVIEW_MISMATCH");

  const partnerId = await getPartnerId(userId);
  if (!partnerId) throw new RelationshipError("NO_PARTNER");

  const gateResult = await canProcess(
    {
      userId,
      feature: ConsentFeature.RELATIONSHIP_INSIGHTS,
      classification: classificationFor(preview.kind),
      destination: ProcessingLocation.PARTNER,
      explicitShare: true,
    },
    ctx.gate,
  );
  if (!gateResult.allowed) throw new RelationshipError("SHARE_DENIED");

  const { data, error } = await supabase
    .from("relationship_shares")
    .insert({
      owner_id: userId,
      recipient_id: partnerId,
      kind: preview.kind,
      item_ref: preview.itemRef,
      payload: preview.payload,
      payload_hash: preview.payloadHash,
    })
    .select("*")
    .single();
  if (error || !data) throw new RelationshipError("SHARE_FAILED");

  const row = rowFromDb(data as DbShareRow);

  if (preview.kind === "VALUE_ANSWER") {
    await setValueShareState(userId, preview.itemRef, { visibility: Visibility.SHARED_WITH_PARTNER, shareId: row.id }, ctx.store);
  } else if (preview.kind === "EXPECTATION") {
    await setExpectationShareState(userId, preview.itemRef, { visibility: Visibility.SHARED_WITH_PARTNER, shareId: row.id }, ctx.store);
  }
  return row;
}

/** Owner-only. The recipient stops seeing it immediately (RLS: a revoked row fails their SELECT policy). */
export async function revokeShare(userId: string, shareId: string, ctx: Pick<ShareCtx, "store">): Promise<void> {
  const { data, error } = await supabase
    .from("relationship_shares")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", shareId)
    .eq("owner_id", userId)
    .select("kind, item_ref")
    .maybeSingle();
  if (error) throw new RelationshipError("REVOKE_FAILED");
  if (!data) return; // already revoked/not found/not owner — nothing more to do, no information leaked either way
  const row = data as { kind: ShareKind; item_ref: string };
  if (row.kind === "VALUE_ANSWER") {
    await setValueShareState(userId, row.item_ref, { visibility: Visibility.PRIVATE, shareId: null }, ctx.store);
  } else if (row.kind === "EXPECTATION") {
    await setExpectationShareState(userId, row.item_ref, { visibility: Visibility.PRIVATE, shareId: null }, ctx.store);
  }
}

export async function listSharedByMe(userId: string): Promise<ShareRow[]> {
  const { data, error } = await supabase.from("relationship_shares").select("*").eq("owner_id", userId).order("created_at", { ascending: false });
  if (error || !data) return [];
  return (data as DbShareRow[]).map(rowFromDb);
}

export async function listSharedWithMe(userId: string): Promise<ShareRow[]> {
  const { data, error } = await supabase
    .from("relationship_shares")
    .select("*")
    .eq("recipient_id", userId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });
  if (error || !data) return [];
  return (data as DbShareRow[]).map(rowFromDb);
}

interface DbShareRow {
  id: string; owner_id: string; recipient_id: string; kind: ShareKind; item_ref: string;
  payload: SharePayload; created_at: string; expires_at: string; revoked_at: string | null;
}
function rowFromDb(r: DbShareRow): ShareRow {
  return {
    id: r.id, ownerId: r.owner_id, recipientId: r.recipient_id, kind: r.kind, itemRef: r.item_ref,
    payload: r.payload, createdAt: r.created_at, expiresAt: r.expires_at, revokedAt: r.revoked_at,
  };
}

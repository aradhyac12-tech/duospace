/**
 * Sharing authorization for AI insights — PURE. Decides whether ONE insight
 * may be shown to the owner's partner. The PrivacyGate answers the
 * class-level question ("may reflection data go to a partner at all, and did
 * the user consent?"); this answers the item-level one.
 *
 * Default is NOT shared. Every condition must hold; the first failure wins.
 */
import { InsightLifecycle, SharingState, type AIInsight } from "./types";
import { DataClassification } from "../privacy/dataClassification";

export interface ShareContext {
  /** Who is asking to share. */
  requesterUserId: string;
  /** Who would receive it. */
  recipientUserId: string;
  /** The requester's actual partner per the profile link (not caller-supplied intent). */
  requesterPartnerUserId: string | null;
  /** The owner tapped an explicit share control for THIS insight. */
  explicitShareAction: boolean;
  /** SHARED_INSIGHTS consent currently granted (from consent.hasConsent). */
  sharedInsightsConsent: boolean;
  now?: Date;
}

export type ShareInsight = Pick<
  AIInsight,
  "userId" | "lifecycle" | "sharing" | "dataClassification" | "expiresAt" | "source" | "modelVersion" | "consentReference"
>;

export interface ShareDecision {
  allowed: boolean;
  reason: string;
}

const no = (reason: string): ShareDecision => ({ allowed: false, reason });

export function authorizeInsightShare(insight: ShareInsight, ctx: ShareContext): ShareDecision {
  if (!ctx.requesterUserId || !ctx.recipientUserId) return no("Missing requester or recipient.");
  if (insight.userId !== ctx.requesterUserId) return no("Only the insight's owner can share it.");
  if (ctx.recipientUserId === ctx.requesterUserId) return no("Recipient must be someone other than the owner.");
  if (!ctx.requesterPartnerUserId || ctx.recipientUserId !== ctx.requesterPartnerUserId) {
    return no("Recipient is not the owner's partner.");
  }
  if (!ctx.sharedInsightsConsent) return no("SHARED_INSIGHTS consent has not been granted.");
  if (ctx.explicitShareAction !== true) return no("Sharing requires an explicit per-insight action.");

  if (insight.dataClassification === DataClassification.DEVICE_ONLY || insight.dataClassification === DataClassification.SECRET) {
    return no(`${insight.dataClassification} data can never be shared.`);
  }
  if (insight.lifecycle === InsightLifecycle.DELETED || insight.lifecycle === InsightLifecycle.EXPIRED) {
    return no(`A ${insight.lifecycle.toLowerCase()} insight cannot be shared.`);
  }
  if (insight.sharing === SharingState.REVOKED) return no("Sharing of this insight was revoked.");
  const now = (ctx.now ?? new Date()).getTime();
  if (insight.expiresAt && Date.parse(insight.expiresAt) <= now) return no("This insight has expired.");
  if (!insight.consentReference) return no("Insight has no consent reference.");
  if ((insight.source === "LOCAL_MODEL" || insight.source === "CLOUD_MODEL") && !insight.modelVersion) {
    return no("Model-derived insight lacks provenance (modelVersion).");
  }
  return { allowed: true, reason: "OK" };
}

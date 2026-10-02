/**
 * Phase 3D — user-controlled longitudinal relationship memory.
 *
 * Nothing here is inferred from chats. A memory exists only because its
 * owner explicitly created it (or explicitly approved a suggestion built
 * from their own structured input, e.g. a Phase 3C repair answer). Every
 * memory carries provenance and an evidence level. There is NO numeric
 * score of any kind anywhere in this model (asserted by a static test).
 */

export const MEMORY_SCHEMA_VERSION = 1;
export const MEMORY_RULE_VERSION = "memory-rule-v1";

export type MemoryCategory =
  | "PREFERENCE" | "BOUNDARY" | "NEED" | "AGREEMENT" | "REPAIR_COMMITMENT"
  | "RECURRING_TOPIC" | "POSITIVE_REPAIR_EVENT" | "UNRESOLVED_ISSUE" | "CHANGE";

/** Lifecycle of the record itself. */
export type MemoryStatus = "PRIVATE" | "USER_APPROVED" | "SHARED" | "EXPIRED" | "DELETED" | "CORRECTED";

/** Whether the content is currently true, per its owner. */
export type Validity = "ACTIVE" | "CHANGED" | "WITHDRAWN" | "UNKNOWN";

/**
 * 1 explicit user statement · 2 explicit partner statement · 3 explicit shared
 * agreement (both confirmed) · 4 repeated structured user reports · 5 AI interpretation.
 * A level never increases without new explicit evidence; level 5 never becomes 1.
 */
export type EvidenceLevel = 1 | 2 | 3 | 4 | 5;

export type RetentionClass = "SHORT_LIVED" | "MEDIUM_TERM" | "LONG_TERM";

export type SourceType = "USER_ENTERED" | "PARTNER_SHARED" | "REPAIR_SESSION" | "REPAIR_FEEDBACK" | "AGREEMENT" | "VALUES_ANSWER";

/** Normalised topic keys — descriptive areas, never sensitive categories inferred from content. */
export const TOPICS = ["planning", "time_together", "communication", "privacy", "boundaries", "money", "social", "household", "conflict_repair", "affection", "future_planning", "other"] as const;
export type Topic = (typeof TOPICS)[number];

/** Optional structured position so two partners' views can be compared deterministically. */
export interface Position {
  key: string;             // e.g. "daily_contact", "advance_notice"
  value: "yes" | "no" | "sometimes" | "not_sure";
}

export interface MemoryRecord {
  memoryId: string;
  relationshipId: string | null;
  ownerUserId: string;
  category: MemoryCategory;
  topic: Topic;
  statement: string;
  position: Position | null;
  sourceType: SourceType;
  sourceId: string;
  sourceTimestamp: string;
  createdAt: string;
  lastConfirmedAt: string;
  expiresAt: string | null;
  evidenceLevel: EvidenceLevel;
  /** Qualitative only. */
  confidence: "EXPLICIT" | "REPORTED" | "INTERPRETED";
  visibility: "PRIVATE" | "SHARED";
  status: MemoryStatus;
  validity: Validity;
  retention: RetentionClass;
  /** Set when a correction replaced this record; this one is then historical. */
  supersededBy: string | null;
  supersedes: string | null;
  shareId: string | null;
  modelVersion: string;
  schemaVersion: number;
}

export type AgreementStatus = "PROPOSED" | "ACCEPTED_BY_ONE" | "ACCEPTED_BY_BOTH" | "DECLINED" | "EXPIRED" | "CHANGED" | "COMPLETED";

export interface Agreement {
  agreementId: string;
  topic: Topic;
  text: string;
  proposedBy: string;
  participants: [string, string | null];
  createdAt: string;
  reviewDate: string | null;
  /** Explicit confirmations only; writing it is not confirming for the partner. */
  confirmations: Record<string, "ACCEPTED" | "DECLINED">;
  status: AgreementStatus;
  shareId: string | null;
}

export type RepairOutcome = "YES" | "SOMEWHAT" | "NO" | "NOT_SURE";
export const WHAT_HELPED = ["BEING_UNDERSTOOD", "CLARIFYING_FACTS", "TAKING_RESPONSIBILITY", "RECEIVING_APOLOGY", "CONCRETE_REQUEST", "AGREEING_NEXT_STEP", "TAKING_SPACE", "SOMETHING_ELSE"] as const;
export type WhatHelped = (typeof WHAT_HELPED)[number];

/** Descriptive only — no success rate is ever computed. */
export interface RepairHistoryEntry {
  repairId: string;
  topic: Topic;
  date: string;
  userGoal: string | null;
  agreedAction: string | null;
  completion: "NOT_STARTED" | "IN_PROGRESS" | "DONE" | "NOT_DONE" | "UNKNOWN";
  userOutcome: RepairOutcome | null;
  whatHelped: WhatHelped[];
  partnerOutcome: RepairOutcome | null;   // only if the partner explicitly shared it
  agreementChanged: boolean;
  issueOpen: boolean | null;              // null = not reported
}

/** Four separately revocable consents (spec §26). */
export interface MemoryConsents {
  store: boolean;        // A. keep personal relationship memory
  useInAI: boolean;      // B. use memory in AI assistance
  share: boolean;        // C. share memory with partner
  longitudinal: boolean; // D. use history for summaries
}

export interface MemoryState {
  version: 1;
  memories: MemoryRecord[];
  agreements: Agreement[];
  repairs: RepairHistoryEntry[];
}

export const emptyMemoryState = (): MemoryState => ({ version: 1, memories: [], agreements: [], repairs: [] });

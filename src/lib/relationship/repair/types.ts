/**
 * Phase 3C — Conflict Repair: domain model.
 *
 * A private, user-controlled preparation flow. Every statement carries a
 * kind (FACT / EXPERIENCE / INTERPRETATION / UNKNOWN / POSSIBILITY /
 * SUGGESTION) and a source. Nothing is inferred about the partner; nothing
 * is shared without an explicit share action on a user-approved message.
 * Sessions live in memory; they are never written to the server.
 */

export const REPAIR_CONTRACT_VERSION = "repair-contract-v1";
export const REPAIR_VALIDATOR_VERSION = "repair-validator-v1";
export const REPAIR_RULE_VERSION = "repair-rule-v1";

export type RepairStage =
  | "PAUSE" | "FACTS" | "IMPACT" | "UNDERSTANDING" | "RESPONSIBILITY" | "BOUNDARY"
  | "REPAIR_GOAL" | "REQUEST" | "NEXT_TIME" | "REVIEW" | "SHARE" | "COMPLETE"
  /** Safety gate tripped: only support information and exit are offered. */
  | "SAFETY_HOLD"
  | "EXITED";

export const STAGE_ORDER: readonly RepairStage[] = ["PAUSE", "FACTS", "IMPACT", "UNDERSTANDING", "RESPONSIBILITY", "BOUNDARY", "REPAIR_GOAL", "REQUEST", "NEXT_TIME", "REVIEW", "SHARE", "COMPLETE"];

/** The user's own private answers (spec §3, questions 1–14) plus optional partner words the user pastes. */
export interface RepairAnswers {
  whatHappened?: string;           // 1
  concreteEvent?: string;          // 2
  myExperience?: string;           // 3
  whatMatteredToMe?: string;       // 4
  whatMatteredToPartnerGuess?: string; // 5 — the user's GUESS; always an interpretation
  uncertainAbout?: string;         // 6
  myResponsibility?: string;       // 7
  stillNeedToExplain?: string;     // 8
  wishPartnerUnderstood?: string;  // 9
  wantToUnderstand?: string;       // 10
  boundary?: string;               // 11
  repairLooksLike?: string;        // 12
  specificChange?: string;         // 13
  willingToDo?: string;            // 14
  /** Words the partner actually said/wrote, pasted by the user. */
  partnerSaid?: string;
  partnerSaidMessageId?: string | null;
  partnerSaidAt?: string | null;
  /** Explicit user choices — never inferred. */
  apologize?: boolean;
  rememberDifferently?: boolean;
  disagreeWithInterpretation?: boolean;
  cannotAgreeToRequest?: boolean;
}

export type RepairField = keyof Omit<RepairAnswers, "partnerSaidMessageId" | "partnerSaidAt" | "apologize" | "rememberDifferently" | "disagreeWithInterpretation" | "cannotAgreeToRequest">;

export type StatementKind = "FACT" | "EXPERIENCE" | "INTERPRETATION" | "UNKNOWN" | "POSSIBILITY" | "SUGGESTION";

export interface RepairSource {
  sourceType: "USER_REFLECTION" | "PARTNER_MESSAGE" | "RULE_TEMPLATE";
  sourceField: RepairField | null;
  sourcePartner: "SELF" | "PARTNER" | null;
  sourceMessageId: string | null;
  sourceTimestamp: string | null;
}

export interface RepairStatement {
  kind: StatementKind;
  text: string;
  sources: RepairSource[];
}

export type SafetyCategory =
  | "THREAT_OR_VIOLENCE" | "STALKING_OR_MONITORING" | "COERCION_OR_CONTROL" | "SEXUAL_COERCION"
  | "SELF_HARM_THREAT_AS_CONTROL" | "THREAT_TO_CHILDREN_OR_PETS" | "ISOLATION" | "FINANCIAL_COERCION"
  | "BLACKMAIL" | "IMMEDIATE_DANGER" | "CHECK_FAILED";

export interface SafetyState {
  status: "CLEAR" | "CONCERN";
  categories: SafetyCategory[];
  /** Never the user's text; only which field matched. */
  matchedFields: RepairField[];
}

export type MessageComponentKind = "ACKNOWLEDGE" | "OWN" | "EXPLAIN" | "UNDERSTAND" | "CLARIFY" | "REQUEST" | "BOUNDARY" | "NEXT_TIME";

export interface MessageComponent { kind: MessageComponentKind; text: string; sources: RepairSource[] }

export type RepairEdit =
  | "NOT_WHAT_I_MEANT" | "TOO_APOLOGETIC" | "TOO_DEFENSIVE" | "TOO_FORMAL" | "KEEP_MY_BOUNDARY"
  | "MAKE_SHORTER" | "ASK_INSTEAD_OF_ASSUME" | "DONT_SHARE";

export interface QualityCheck {
  describesSpecificBehavior: boolean;
  separatesFactFromInterpretation: boolean;
  noMindReading: boolean;
  preservesDisagreement: boolean;
  preservesBoundary: boolean;
  noBlame: boolean;
  hasConcreteRepairAction: boolean;
  hasRequestWhenAppropriate: boolean;
  noForcedReconciliation: boolean;
  noManipulation: boolean;
  reflectsUserPosition: boolean;
  noInventedPartnerFeelings: boolean;
  noUnsafeEngagement: boolean;
}

export type ShareState = "PRIVATE" | "READY_TO_SHARE" | "SHARED" | "RECEIVED" | "RESPONDED" | "WITHDRAWN";

export interface RepairSession {
  repairSessionId: string;
  conflictId: string;
  userId: string;
  /** The partner link at the time — context only, never consent. */
  relationshipId: string | null;
  stage: RepairStage;
  answers: RepairAnswers;
  safetyState: SafetyState;
  shareState: ShareState;
  shareId: string | null;
  createdAt: string;
  expiresAt: string;
}

/** The repair object (spec §5) produced for REVIEW. */
export interface RepairResult {
  repairSessionId: string;
  conflictId: string;
  userId: string;
  relationshipId: string | null;
  stage: RepairStage;
  facts: RepairStatement[];
  userExperience: RepairStatement[];
  userNeeds: RepairStatement[];
  partnerUnderstanding: RepairStatement[];
  unknowns: RepairStatement[];
  possibilities: RepairStatement[];
  responsibility: RepairStatement[];
  explanation: RepairStatement[];
  boundary: RepairStatement[];
  repairGoal: RepairStatement[];
  concreteRequest: RepairStatement[];
  nextTimePlan: RepairStatement[];
  repairQuestions: RepairStatement[];
  /** Communication-level notes about the user's own text (never traits). */
  communicationNotes: RepairStatement[];
  components: MessageComponent[];
  proposedMessage: string;
  quality: QualityCheck;
  safetyState: SafetyState;
  /** Qualitative: how completely the message is supported by the user's own answers. */
  confidence: "SUPPORTED" | "PARTIAL" | "INSUFFICIENT_INFORMATION";
  processingLocation: "ON_DEVICE";
  source: "user_reflection";
  executionMode: "RULE_BASED" | "LOCAL";
  modelVersion: string;
  validatorVersion: string;
  contractVersion: string;
  appliedEdits: RepairEdit[];
  /** Language of the DuoSpace-authored templates in this result. */
  language: import("../i18n/lang").RelLang;
  /** True when the user's text isn't English: nothing was interpreted, words shown verbatim. */
  limitedMode: boolean;
  shareable: boolean;
  createdAt: string;
  expiresAt: string;
}

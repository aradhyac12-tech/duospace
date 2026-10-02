/**
 * Phase 3B — structured response support (partner responsiveness).
 *
 * Responsiveness here = understanding the partner's EXPRESSED perspective,
 * recognising what they said matters, showing that understanding, responding
 * to the expressed request, and showing care — WITHOUT requiring agreement,
 * compliance, blame acceptance or giving up one's own needs/boundaries.
 * See docs/RESPONSIVENESS_SCIENTIFIC_FOUNDATION.md.
 *
 * Nothing here is persisted: support objects live in memory on the device
 * for the duration of the screen (see §Persistence in .ai/DYADIC_AI_SPEC.md).
 */

export type SourceField = "partnerMessage" | "whatIHeard" | "myExperience" | "myRequest" | "myBoundary" | "myOwnAction";

/** Every claim carries where it came from. No source → the claim is not generated. */
export interface SourceRef {
  sourceField: SourceField;
  sourcePartner: "PARTNER" | "SELF";
  /** Optional: the chat message id when the text came from a real message the user selected. */
  sourceMessageId: string | null;
  sourceTimestamp: string | null;
}

export interface GroundedText {
  text: string;
  /** EXPLICIT = verbatim / directly stated; TENTATIVE = an interpretation, always labelled as such. */
  kind: "EXPLICIT" | "TENTATIVE";
  sources: SourceRef[];
}

/** Characteristics of THIS text only — never a trait of a person. */
export type TextCharacteristic =
  | "ACCUSATION" | "VAGUE_REQUEST" | "UNCLEAR_EXPECTATION" | "SPECIFIC_REQUEST"
  | "STATED_FEELING" | "ACKNOWLEDGMENT" | "CLARIFICATION" | "DEFENSIVE_EXPLANATION"
  | "AMBIGUOUS" | "CONTROL_OR_MONITORING_REQUEST";

export type ComponentKind = "ACKNOWLEDGE" | "REFLECT" | "CLARIFY" | "OWN" | "EXPLAIN" | "REQUEST" | "BOUNDARY";

export interface ResponseComponent {
  kind: ComponentKind;
  text: string;
  sources: SourceRef[];
}

export interface ResponseSupportInput {
  partnerMessage: string;
  partnerMessageId?: string | null;
  partnerMessageAt?: string | null;
  /** The user's own reading of it (for the understanding check). */
  whatIHeard?: string;
  /** What the user experienced — their perspective is never erased. */
  myExperience?: string;
  /** Something the user chooses to own. Never inferred; never forced. */
  myOwnAction?: string;
  /** Only when the user explicitly wants to apologise. */
  apologize?: boolean;
  /** "I see it differently" — respectful disagreement is a valid responsive pattern. */
  seeItDifferently?: boolean;
  myRequest?: string;
  myBoundary?: string;
  /** Optional: what the user is trying to achieve — checked for manipulation intent. */
  myGoal?: string;
}

export type SupportCorrection =
  | "NOT_WHAT_I_MEANT" | "TOO_APOLOGETIC" | "TOO_DEFENSIVE" | "TOO_FORMAL"
  | "MAKE_CLEARER" | "KEEP_MY_BOUNDARY" | "DONT_SHARE" | "REGENERATE";

export interface ResponseSupport {
  whatPartnerExplicitlySaid: GroundedText;
  whatSeemsToMatter: GroundedText[];
  whatIsUnknown: string[];
  textCharacteristics: TextCharacteristic[];
  /** Whether DuoSpace recommends asking before answering (ambiguous / several readings). */
  clarificationFirst: boolean;
  clarifyingQuestion: string;
  /** Present when the user supplied "what I heard". */
  understandingCheck: string | null;
  components: ResponseComponent[];
  possibleResponse: string;
  userPerspective: GroundedText | null;
  /** Notes to the user (e.g. "You don't have to agree to be responsive"). */
  notes: string[];
  uncertainty: string;
  source: "user_supplied_text";
  processingLocation: "ON_DEVICE";
  modelVersion: string;
  createdAt: string;
  expiresAt: string;
  /** The user asked DuoSpace not to keep/share anything about this. Nothing is persisted either way. */
  shareable: boolean;
  appliedCorrections: SupportCorrection[];
  variant: number;
  /** Language of DuoSpace's own template text; limitedMode = user text not English, nothing interpreted. */
  language?: string;
  limitedMode?: boolean;
  /** Safety gate tripped: no reply is drafted; only neutral guidance is shown. */
  safetyHold?: boolean;
  insufficientInformation: boolean;
  /** Set when the request itself asked for manipulation/coercion; possibleResponse is then a direct alternative. */
  refusal: string | null;
}

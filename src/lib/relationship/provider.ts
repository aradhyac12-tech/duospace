/**
 * Provider-neutral AI boundary for Relationship Reflection.
 *
 * The domain (stores, pipeline, sharing, UI) depends ONLY on this file. It
 * knows nothing about OpenAI, Gemini, Claude, Supabase Edge Functions or any
 * other vendor, and provider selection lives outside it (registry.ts).
 *
 * A provider receives the MINIMUM data for one analysis — never a user id,
 * never consent state, never timestamps, never the partner, never anything
 * the user marked "prefer not to answer". It returns DRAFTS (plain text
 * fields); the pipeline alone decides identity, classification, provenance,
 * consent reference and expiry, and runs the safety validator on every draft.
 * A provider cannot set any of those, by construction: parseProviderResponse
 * rebuilds each draft from a fixed set of fields and discards the rest.
 */
import type { InsightConfidence } from "../ai/types";
import { ProcessingLocation } from "../privacy/dataClassification";
import { RelationshipError } from "./errors";
import { CATEGORY_LABEL, AnswerMode, ExpectationType, type Expectation, type ReflectionFields, type ValueCategory, type ValuesRecord } from "./types";
import { getQuestion, optionLabel } from "./questions";

// ── provider description ──────────────────────────────────────────────────

export interface ProviderInfo {
  id: string;
  /** How output is produced — becomes the insight's `source`. V1 accepts only LOCAL_RULE / LOCAL_MODEL. */
  kind: "LOCAL_RULE" | "LOCAL_MODEL" | "CLOUD_MODEL";
  processingLocation: ProcessingLocation;
  modelVersion: string;
  /** false for mocks/dev providers: refused in production builds. */
  isProduction: boolean;
  /** Honest one-liner for docs/diagnostics. Never claims a model that doesn't exist. */
  description: string;
}

// ── minimal inputs ────────────────────────────────────────────────────────

export interface ValuesAnalysisInput {
  /** Only ANSWERED items. "Prefer not to answer" items are absent entirely. */
  answers: { category: ValueCategory; categoryLabel: string; prompt: string; choiceLabel: string; note?: string }[];
  /** Category labels where the user chose "not sure" — labels only. */
  notSureCategories: string[];
  /** The ONLY evidence strings a draft may cite (anti-fabrication). */
  evidenceCatalog: string[];
}

export interface ExpectationsAnalysisInput {
  items: { category: ValueCategory; categoryLabel: string; type: ExpectationType; importance: "LOW" | "MEDIUM" | "HIGH"; statement?: string }[];
  evidenceCatalog: string[];
}

export interface ReflectionAnalysisInput {
  /** Only the fields the user filled in. */
  fields: Partial<ReflectionFields>;
  evidenceCatalog: string[];
}

// ── draft output ──────────────────────────────────────────────────────────

export interface ProviderInsightDraft {
  /** What the user reported — attributed to the user ("You described…"). */
  observation: string;
  /** How well the OBSERVATION is supported by the provided information (not confidence in any interpretation). */
  confidence: InsightConfidence;
  /** What is unknown / could change the picture. */
  uncertainty: string;
  context?: string;
  /** Hedged possibilities, at least two. */
  possibleExplanations: string[];
  /** An invitation to the user, never an instruction and never about what the partner should do. */
  suggestedAction?: string;
  /** Strings drawn from the input's evidenceCatalog. */
  evidence: string[];
}

export interface ProviderResponse {
  insights: ProviderInsightDraft[];
}

export interface RelationshipAIProvider {
  readonly info: ProviderInfo;
  analyzeValues(input: ValuesAnalysisInput): Promise<ProviderResponse>;
  analyzeExpectations(input: ExpectationsAnalysisInput): Promise<ProviderResponse>;
  analyzeCommunicationReflection(input: ReflectionAnalysisInput): Promise<ProviderResponse>;
}

// ── input builders (data minimisation) ────────────────────────────────────

export function buildValuesInput(record: ValuesRecord, opts: { includeNotes?: boolean; categories?: ValueCategory[] } = {}): ValuesAnalysisInput {
  const wanted = opts.categories ? new Set(opts.categories) : null;
  const skipped = new Set(record.skippedCategories);
  const answers: ValuesAnalysisInput["answers"] = [];
  const notSure = new Set<string>();
  for (const a of record.answers) {
    if (skipped.has(a.category) || (wanted && !wanted.has(a.category))) continue;
    if (a.mode === AnswerMode.PREFER_NOT_TO_ANSWER) continue; // never processed
    if (a.mode === AnswerMode.NOT_SURE) { notSure.add(CATEGORY_LABEL[a.category]); continue; }
    const q = getQuestion(a.questionId);
    const label = optionLabel(a.questionId, a.choiceId);
    if (!q || !label) continue;
    answers.push({
      category: a.category, categoryLabel: CATEGORY_LABEL[a.category], prompt: q.prompt, choiceLabel: label,
      ...(opts.includeNotes && a.note ? { note: a.note } : {}),
    });
  }
  const answered = Array.from(new Set(answers.map((x) => x.categoryLabel)));
  const evidenceCatalog = [
    ...answered.map((l) => `Your answers in ${l}`),
    ...Array.from(notSure).map((l) => `Your "not sure" answers in ${l}`),
  ];
  return { answers, notSureCategories: Array.from(notSure), evidenceCatalog };
}

export function buildExpectationsInput(items: Expectation[], opts: { includeStatements?: boolean } = {}): ExpectationsAnalysisInput {
  const active = items.filter((e) => e.status === "ACTIVE");
  const mapped = active.map((e) => ({
    category: e.category, categoryLabel: CATEGORY_LABEL[e.category], type: e.type, importance: e.importance,
    ...(opts.includeStatements ? { statement: e.statement } : {}),
  }));
  // Only cite what exists: a catalog entry for a type the user never used
  // would let a provider "ground" an insight in evidence that isn't there.
  const has = (t: ExpectationType) => mapped.some((m) => m.type === t);
  const evidenceCatalog = [
    ...(has(ExpectationType.PREFERENCE) ? ["Your items marked as preferences"] : []),
    ...(has(ExpectationType.EXPECTATION) ? ["Your items marked as expectations"] : []),
    ...(has(ExpectationType.BOUNDARY) ? ["Your items marked as boundaries"] : []),
    ...(mapped.length ? ["Your importance ratings"] : []),
    ...Array.from(new Set(mapped.map((m) => `Your items in ${m.categoryLabel}`))),
  ];
  return { items: mapped, evidenceCatalog };
}

export function buildReflectionInput(fields: Partial<ReflectionFields>): ReflectionAnalysisInput {
  const evidenceCatalog: string[] = [];
  if (fields.whatHappened) evidenceCatalog.push("Your description of what happened");
  if (fields.hoped) evidenceCatalog.push("Your description of what you were hoping for");
  if (fields.felt) evidenceCatalog.push("Your description of how you felt");
  if (fields.partnerUnderstood) evidenceCatalog.push("Your thoughts about how your partner may have understood it");
  if (fields.nextTime) evidenceCatalog.push("What you would like to communicate differently");
  return { fields: { ...fields }, evidenceCatalog };
}

// ── response parsing (malformed-response defence) ─────────────────────────

const CONFIDENCES = ["LOW", "MEDIUM", "HIGH"] as const;
const MAX_DRAFTS = 6;
const MAX_STR = 1000;

const isStr = (x: unknown): x is string => typeof x === "string" && x.length <= MAX_STR;
const isStrArr = (x: unknown, max: number): x is string[] => Array.isArray(x) && x.length <= max && x.every(isStr);

/**
 * Validates an untrusted provider response and rebuilds each draft from the
 * known fields only. Anything else a provider sends (ids, classification,
 * source, consent references, extra prose) is dropped, not trusted.
 * Throws RelationshipError("MALFORMED_RESPONSE") — with a fixed message and no
 * echo of the response — on any structural problem.
 */
export function parseProviderResponse(raw: unknown): ProviderResponse {
  const fail = (): never => { throw new RelationshipError("MALFORMED_RESPONSE"); };
  if (typeof raw !== "object" || raw === null) return fail();
  const insights = (raw as { insights?: unknown }).insights;
  if (!Array.isArray(insights) || insights.length > MAX_DRAFTS) return fail();
  const out: ProviderInsightDraft[] = [];
  for (const d of insights) {
    if (typeof d !== "object" || d === null) return fail();
    const x = d as Record<string, unknown>;
    if (!isStr(x.observation) || !x.observation.trim()) return fail();
    if (!isStr(x.uncertainty) || !x.uncertainty.trim()) return fail();
    if (!CONFIDENCES.includes(x.confidence as (typeof CONFIDENCES)[number])) return fail();
    if (!isStrArr(x.possibleExplanations, 8)) return fail();
    if (!isStrArr(x.evidence, 8)) return fail();
    if (x.context !== undefined && !isStr(x.context)) return fail();
    if (x.suggestedAction !== undefined && !isStr(x.suggestedAction)) return fail();
    out.push({
      observation: x.observation,
      confidence: x.confidence as InsightConfidence,
      uncertainty: x.uncertainty,
      possibleExplanations: x.possibleExplanations,
      evidence: x.evidence,
      ...(x.context !== undefined ? { context: x.context as string } : {}),
      ...(x.suggestedAction !== undefined ? { suggestedAction: x.suggestedAction as string } : {}),
    });
  }
  return { insights: out };
}

/**
 * Relationship Reflection AI pipeline — the local-first flow from the brief:
 *
 *   USER INPUT -> LOCAL VALIDATION -> PRIVACY GATE -> AI PROCESSOR ->
 *   STRUCTURED OUTPUT -> AI SAFETY VALIDATOR -> ENCRYPTED LOCAL STORAGE -> USER DISPLAY
 *
 * This file is the ONLY place that calls a RelationshipAIProvider. Every
 * step is enforced in order and every step can reject:
 *   - PrivacyGate is re-evaluated on every call (no cached "consent granted
 *     once" — see .ai/CONSENT_MODEL.md); a revoke takes effect on the very
 *     next analysis.
 *   - The provider gets only the minimized input (see provider.ts's
 *     buildXInput helpers) — never a userId, never raw stored records.
 *   - The provider's response is parsed defensively (parseProviderResponse)
 *     before anything else touches it.
 *   - Every draft is turned into a NewAIInsight with fields the pipeline
 *     controls (id, userId, source, classification, processingLocation,
 *     consentReference, expiresAt) — a provider cannot set any of these.
 *   - saveLocalInsight() re-runs the FULL safety validator + provenance
 *     check before anything is written (belt-and-braces: this pipeline
 *     already ran it once via runSafetyCheckedAnalysis, so a bad draft is
 *     rejected twice, not trusted twice).
 *   - Drafts that fail the safety validator are dropped individually; the
 *     call only fails outright if none survive.
 */
import type { AIInsight, InsightConfidence, RelationshipAnalysisKind } from "../ai/types";
import { InsightSource } from "../ai/types";
import { checkGrounding } from "../ai/groundingValidator";
import { validateInsight } from "../ai/outputValidator";
import { saveLocalInsight, listLocalInsights } from "../ai/localInsightStore";
import { canProcess } from "../privacy/privacyGate";
import { ConsentFeature } from "../privacy/consentFeatures";
import { DataClassification, ProcessingLocation } from "../privacy/dataClassification";
import type { RelationshipDeps } from "./deps";
import { defaultClock } from "./deps";
import { RelationshipError, toErrorCode } from "./errors";
import { recordRelationshipEvent, type RelationshipOp } from "./telemetry";
import {
  buildExpectationsInput, buildReflectionInput, buildValuesInput,
  parseProviderResponse, type ProviderInsightDraft,
} from "./provider";
import type { Expectation, ReflectionFields, ValuesRecord } from "./types";

const DEFAULT_TIMEOUT_MS = 15_000;

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => never): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => { try { onTimeout(); } catch (e) { reject(e); } }, ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Expiry per analysis kind (brief §19: a reflection about one interaction is not a permanent fact). */
const EXPIRY_DAYS: Record<RelationshipAnalysisKind, number> = {
  VALUES: 180,
  EXPECTATIONS: 180,
  COMMUNICATION_REFLECTION: 30,
};

function expiresAt(now: Date, kind: RelationshipAnalysisKind): string {
  const d = new Date(now);
  d.setDate(d.getDate() + EXPIRY_DAYS[kind]);
  return d.toISOString();
}

async function gateOrThrow(userId: string, deps: RelationshipDeps): Promise<void> {
  const result = await canProcess(
    {
      userId,
      feature: ConsentFeature.RELATIONSHIP_INSIGHTS,
      classification: DataClassification.SENSITIVE, // the INPUT being processed (values/expectations/reflection) — SENSITIVE at minimum
      destination: deps.provider.info.processingLocation, // DEVICE for both local providers; anything else is refused before this
    },
    deps.gate,
  );
  if (!result.allowed) throw new RelationshipError("CONSENT_DENIED");
}

function draftToNewInsight(
  draft: ProviderInsightDraft,
  ctx: { userId: string; analysisKind: RelationshipAnalysisKind; consentReference: string; now: Date; provider: RelationshipDeps["provider"]; newId: () => string },
): AIInsight {
  return {
    id: ctx.newId(),
    feature: ConsentFeature.RELATIONSHIP_INSIGHTS,
    userId: ctx.userId,
    createdAt: ctx.now.toISOString(),
    observation: draft.observation,
    confidence: draft.confidence as InsightConfidence,
    uncertainty: draft.uncertainty,
    context: draft.context,
    possibleExplanations: draft.possibleExplanations,
    suggestedAction: draft.suggestedAction,
    evidence: draft.evidence,
    analysisKind: ctx.analysisKind,
    source: ctx.provider.info.kind === "LOCAL_MODEL" ? InsightSource.LOCAL_MODEL : InsightSource.LOCAL_RULE,
    modelVersion: ctx.provider.info.modelVersion,
    dataClassification: DataClassification.HIGHLY_SENSITIVE,
    processingLocation: ctx.provider.info.processingLocation,
    consentReference: ctx.consentReference,
    lifecycle: "ACTIVE",
    expiresAt: expiresAt(ctx.now, ctx.analysisKind),
    correction: null,
    sharing: "PRIVATE",
    sharedWithUserId: null,
    sharedAt: null,
  };
}

interface RunResult {
  saved: AIInsight[];
  rejected: number;
}

type ProviderCall = (p: RelationshipDeps["provider"]) => Promise<unknown>;

/** Errors after which the deterministic fallback may run. Consent/privacy
 *  refusals are NOT in this list: a denied gate must never be "retried"
 *  with a different provider. */
const FALLBACK_ON: readonly string[] = [
  "LOCAL_MODEL_UNAVAILABLE", "PROVIDER_FAILURE", "PROVIDER_TIMEOUT", "MALFORMED_RESPONSE", "NO_VALID_INSIGHTS", "PROVIDER_NOT_ALLOWED",
];

async function runAnalysis(
  userId: string,
  analysisKind: RelationshipAnalysisKind,
  op: RelationshipOp,
  call: ProviderCall,
  deps: RelationshipDeps,
  catalogFor: () => string[],
  sourceFor: () => string,
): Promise<RunResult> {
  try {
    return await runWithProvider(userId, analysisKind, op, call, deps, deps.provider, catalogFor, sourceFor);
  } catch (err) {
    const code = toErrorCode(err, "PROVIDER_FAILURE");
    const fb = deps.fallbackProvider;
    if (!fb || fb === deps.provider || !FALLBACK_ON.includes(code)) throw err;
    // local model unavailable / invalid → local-rule-v1. Never → cloud.
    return runWithProvider(userId, analysisKind, op, call, deps, fb, catalogFor, sourceFor);
  }
}

async function runWithProvider(
  userId: string,
  analysisKind: RelationshipAnalysisKind,
  op: RelationshipOp,
  call: ProviderCall,
  baseDeps: RelationshipDeps,
  provider: RelationshipDeps["provider"],
  catalogFor: () => string[],
  sourceFor: () => string,
): Promise<RunResult> {
  const deps: RelationshipDeps = { ...baseDeps, provider };
  const callProvider = () => call(provider);
  // PRIVACY: only on-device providers may process relationship data in this
  // phase. Cloud AI is disabled; there is no consent flow for it yet.
  if (provider.info.processingLocation !== ProcessingLocation.DEVICE || provider.info.kind === "CLOUD_MODEL") {
    throw new RelationshipError("CLOUD_NOT_SUPPORTED");
  }
  if (!deps.provider.info.isProduction && !deps.allowNonProductionProvider) {
    throw new RelationshipError("PROVIDER_NOT_ALLOWED");
  }
  await gateOrThrow(userId, deps);
  const consentReference = await deps.getConsentReference(userId, ConsentFeature.RELATIONSHIP_INSIGHTS);
  if (!consentReference) throw new RelationshipError("CONSENT_MISSING");

  const clock = deps.clock ?? defaultClock;
  const started = clock();
  let raw: unknown;
  try {
    raw = await withTimeout(
      callProvider(),
      deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      () => { throw new RelationshipError("PROVIDER_TIMEOUT"); },
    );
  } catch (err) {
    const code = toErrorCode(err, "PROVIDER_FAILURE");
    recordRelationshipEvent(deps.telemetry, { op, outcome: "failure", errorCategory: code, providerType: deps.provider.info.kind, latencyMs: clock() - started });
    if (err instanceof RelationshipError) throw err;
    // Keep the original runtime error (name/message only are ever inspected,
    // by the service's failure classifier) so integrity/ONNX/OOM failures can
    // be told apart. It never reaches telemetry (sanitizeEvent drops it).
    const wrapped = new RelationshipError("PROVIDER_FAILURE");
    (wrapped as { cause?: unknown }).cause = err;
    throw wrapped;
  }
  const latencyMs = clock() - started;

  let parsed;
  let rawCount = 0;
  try {
    parsed = parseProviderResponse(raw);
    rawCount = parsed.insights.length;
  } catch (err) {
    recordRelationshipEvent(deps.telemetry, { op, outcome: "failure", errorCategory: "MALFORMED_RESPONSE", providerType: deps.provider.info.kind, latencyMs });
    throw err;
  }

  // PROVENANCE: every evidence reference must be one of the labels the
  // pipeline itself supplied (the input's evidenceCatalog). A model that
  // invents evidence ("your partner's messages", "your chat history") has
  // that insight rejected — fabricated evidence is never persisted.
  const catalog = new Set(catalogFor());
  parsed = { insights: parsed.insights.filter((d) => d.evidence.length > 0 && d.evidence.every((e) => catalog.has(e))) };
  // GROUNDING (Phase 2D): generated text may not introduce history,
  // frequency or numbers the user never supplied. Rule output is exempt
  // (code-generated counts of the user's own items).
  if (provider.info.kind !== "LOCAL_RULE") {
    const source = sourceFor();
    parsed = { insights: parsed.insights.filter((d) => checkGrounding({
      observation: d.observation, uncertainty: d.uncertainty, context: d.context ?? null,
      possibleExplanations: d.possibleExplanations, suggestedAction: d.suggestedAction ?? null,
    }, source).length === 0) };
  }

  const now = deps.now();
  const candidates = parsed.insights.map((d) => draftToNewInsight(d, { userId, analysisKind, consentReference, now, provider: deps.provider, newId: deps.newId }));
  const fabricated = rawCount - parsed.insights.length;

  const saved: AIInsight[] = [];
  let rejected = fabricated;
  for (const candidate of candidates) {
    const validation = validateInsight(candidate);
    if (!validation.valid) { rejected += 1; continue; }
    try {
      await saveLocalInsight(userId, candidate, deps.backend);
      saved.push(candidate);
    } catch {
      rejected += 1;
    }
  }

  if (rawCount > 0 && saved.length === 0) {
    recordRelationshipEvent(deps.telemetry, { op, outcome: "failure", errorCategory: "NO_VALID_INSIGHTS", providerType: deps.provider.info.kind, latencyMs, count: rejected });
    throw new RelationshipError("NO_VALID_INSIGHTS");
  }
  recordRelationshipEvent(deps.telemetry, { op, outcome: "success", providerType: deps.provider.info.kind, latencyMs, count: saved.length });
  return { saved, rejected };
}

export async function analyzeValues(
  userId: string, record: ValuesRecord, deps: RelationshipDeps, opts?: { categories?: ValuesRecord["skippedCategories"] },
): Promise<RunResult> {
  const input = buildValuesInput(record, { categories: opts?.categories });
  return runAnalysis(userId, "VALUES", "values_analysis", (p) => p.analyzeValues(input), deps, () => input.evidenceCatalog, () => JSON.stringify(input));
}

export async function analyzeExpectations(userId: string, items: Expectation[], deps: RelationshipDeps): Promise<RunResult> {
  const input = buildExpectationsInput(items);
  return runAnalysis(userId, "EXPECTATIONS", "expectations_analysis", (p) => p.analyzeExpectations(input), deps, () => input.evidenceCatalog, () => JSON.stringify(input));
}

export async function analyzeReflection(userId: string, fields: Partial<ReflectionFields>, deps: RelationshipDeps): Promise<RunResult> {
  const input = buildReflectionInput(fields);
  return runAnalysis(userId, "COMMUNICATION_REFLECTION", "reflection_analysis", (p) => p.analyzeCommunicationReflection(input), deps, () => input.evidenceCatalog, () => JSON.stringify(input));
}

/** Lists this user's relationship insights (any analysisKind), newest first. Expired ones are dropped by listLocalInsights itself. */
export async function listRelationshipInsights(userId: string, deps: Pick<RelationshipDeps, "backend" | "now">): Promise<AIInsight[]> {
  const all = await listLocalInsights(userId, deps.backend, deps.now());
  return all
    .filter((i) => i.feature === ConsentFeature.RELATIONSHIP_INSIGHTS)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

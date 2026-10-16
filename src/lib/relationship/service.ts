/**
 * RelationshipAIService — the ONLY entry point the UI uses for relationship
 * AI. Screens never call providers, Transformers.js/ONNX, cloud code or the
 * rule engine directly.
 *
 *   capability detection (local, never uploaded)
 *     → decideExecutionMode (executionMode.ts)
 *     → ONE primary attempt (LOCAL | E2E_CLOUD | RULE_BASED)
 *     → at most ONE RULE_BASED fallback (never LOCAL↔CLOUD in a request)
 *     → common pipeline: PrivacyGate → minimization → schema → provenance
 *       → safety validator → confidence cap → encrypted local store
 *
 * Consent/privacy refusals are final: they are never "retried" elsewhere.
 */
import { analyzeExpectations, analyzeReflection, analyzeValues } from "./pipeline";
import type { RelationshipDeps } from "./deps";
import type { RelationshipAIProvider } from "./provider";
import { RelationshipError, toErrorCode } from "./errors";
import { localRuleProvider } from "./providers/localRuleProvider";
import { localModelProvider } from "./registry";
import { e2eCloudProvider, E2E_CLOUD_STATUS } from "./e2eCloud/e2eCloudProvider";
import { detectCapabilityEnv, computeCapabilities, type LocalAIPlatformCapabilities } from "./localModel/capabilities";
import { LOCAL_MODEL_MANIFEST } from "./localModel/manifest";
import {
  AIExecutionMode, MODE_LABEL, assessDevice, classifyLocalFailure, decideExecutionMode, emptyRuntimeState,
  recordLocalFailure, recordLocalSuccess, type CloudStatus, type DeviceCapability, type LocalRuntimeState,
} from "./executionMode";
import type { AIInsight } from "../ai/types";
import type { Expectation, ReflectionFields, ShareRow, ValuesRecord } from "./types";
import { buildDyadicView, type DyadicExplainer, type DyadicCorrection, type DyadicView } from "./dyadic";
import { ConsentFeature } from "../privacy/consentFeatures";
import { buildLongitudinalSummary, type MemoryConsents, type MemoryRecord, type MemoryState, type SummaryOutcome, type SummaryRephraser, type Topic } from "./memory";
import { prepareRepair as runRepair, type RepairEdit, type RepairOutcome, type RepairRephraser, type RepairSession } from "./repair";
import { supportResponse as runSupport, type ResponseRephraser, type ResponseSupportInput, type SupportCorrection, type SupportOutcome } from "./responsiveness";

export interface ServiceResult { saved: AIInsight[]; rejected: number; mode: AIExecutionMode; label: string; usedFallback: boolean }

export interface RuntimeStateStore { load(): LocalRuntimeState | null; save(s: LocalRuntimeState): void }

const STATE_KEY = "duo_ai_local_runtime_state_v1"; // holds failure kinds/timestamps only — never content
export const browserStateStore: RuntimeStateStore = {
  load() { try { const r = localStorage.getItem(STATE_KEY); return r ? (JSON.parse(r) as LocalRuntimeState) : null; } catch { return null; } },
  save(s) { try { localStorage.setItem(STATE_KEY, JSON.stringify(s)); } catch { /* best effort */ } },
};

export interface ServiceOptions {
  deps: RelationshipDeps;                       // consent/gate/store/telemetry (provider fields are overridden per mode)
  capabilities?: () => LocalAIPlatformCapabilities;
  deviceMemoryGB?: () => number | null;
  cloudStatus?: () => CloudStatus;
  providers?: { local?: RelationshipAIProvider; cloud?: RelationshipAIProvider; rule?: RelationshipAIProvider };
  stateStore?: RuntimeStateStore;
  now?: () => number;
}

type Op = "values" | "expectations" | "reflection";

export function createRelationshipAIService(o: ServiceOptions) {
  const now = o.now ?? Date.now;
  const caps = o.capabilities ?? (() => computeCapabilities(detectCapabilityEnv()));
  const mem = o.deviceMemoryGB ?? (() => detectCapabilityEnv().deviceMemoryGB);
  const cloud = o.cloudStatus ?? (() => E2E_CLOUD_STATUS);
  const store = o.stateStore ?? browserStateStore;
  const local = o.providers?.local ?? localModelProvider;
  const cloudP = o.providers?.cloud ?? e2eCloudProvider;
  const rule = o.providers?.rule ?? localRuleProvider;

  const loadState = (): LocalRuntimeState => {
    const s = store.load();
    // A new model version resets old failure history (recovery path).
    return s && s.modelVersion === LOCAL_MODEL_MANIFEST.modelVersion ? s : emptyRuntimeState(LOCAL_MODEL_MANIFEST.modelVersion);
  };

  function assess(): { device: DeviceCapability; decision: ReturnType<typeof decideExecutionMode> } {
    const device = assessDevice(caps(), mem(), loadState(), now());
    return { device, decision: decideExecutionMode(device, cloud(), true) };
  }

  const providerFor = (m: AIExecutionMode) => (m === "LOCAL" ? local : m === "E2E_CLOUD" ? cloudP : rule);

  async function run(op: Op, call: (deps: RelationshipDeps) => Promise<{ saved: AIInsight[]; rejected: number }>): Promise<ServiceResult> {
    const { decision } = assess();
    if (decision.mode === "UNAVAILABLE") throw new RelationshipError("AI_UNAVAILABLE");
    const attempt = (m: AIExecutionMode) => call({
      ...o.deps, provider: providerFor(m), fallbackProvider: undefined, // the SERVICE owns fallback; no hidden second hop
      allowNonProductionProvider: m !== "RULE_BASED",
    });
    try {
      const res = await attempt(decision.mode);
      if (decision.mode === "LOCAL") store.save(recordLocalSuccess(loadState()));
      return { ...res, mode: decision.mode, label: MODE_LABEL[decision.mode], usedFallback: false };
    } catch (err) {
      const code = toErrorCode(err, "PROVIDER_FAILURE");
      if (code === "CONSENT_DENIED" || code === "CONSENT_MISSING" || code === "VALIDATION" || code === "CLOUD_NOT_SUPPORTED") throw err; // final
      if (decision.mode === "LOCAL") {
        const raw = (err as { cause?: unknown }).cause ?? err;
        store.save(recordLocalFailure(loadState(), classifyLocalFailure(code === "PROVIDER_FAILURE" ? raw : err), now()));
      }
      if (decision.fallback !== "RULE_BASED" || decision.mode === "RULE_BASED") {
        if (decision.mode === "RULE_BASED") throw err;
        throw new RelationshipError("AI_UNAVAILABLE");
      }
      const res = await attempt("RULE_BASED"); // bounded: exactly one fallback, never another model/cloud
      return { ...res, mode: "RULE_BASED", label: MODE_LABEL.RULE_BASED, usedFallback: true };
    }
  }

  return {
    /** Current routing decision (for UI wording / diagnostics). Local-only; nothing uploaded. */
    currentMode: () => assess().decision.mode,
    describe: () => { const a = assess(); return { mode: a.decision.mode, label: MODE_LABEL[a.decision.mode], device: a.device }; },
    analyzeValues: (userId: string, record: ValuesRecord) => run("values", (d) => analyzeValues(userId, record, d)),
    analyzeExpectations: (userId: string, items: Expectation[]) => run("expectations", (d) => analyzeExpectations(userId, items, d)),
    analyzeReflection: (userId: string, fields: Partial<ReflectionFields>) => run("reflection", (d) => analyzeReflection(userId, fields, d)),
    /**
     * Phase 3A dyadic comparison. The deterministic comparison is always the
     * source of truth; in LOCAL mode a model that implements explainDyadic may
     * only rephrase it (validated, rule fallback). RULE_BASED needs no model.
     * E2E_CLOUD is never used for this feature. Consent is required.
     */
    compareWithPartner: async (input: {
      userId: string; partnerId: string | null; values: ValuesRecord; expectations: Expectation[];
      sharedWithMe: ShareRow[]; corrections: DyadicCorrection[];
    }): Promise<DyadicView & { mode: AIExecutionMode; label: string }> => {
      const consented = await o.deps.gate.hasConsent(input.userId, ConsentFeature.RELATIONSHIP_INSIGHTS);
      if (!consented) throw new RelationshipError("CONSENT_MISSING");
      const { decision } = assess();
      if (decision.mode === "UNAVAILABLE") throw new RelationshipError("AI_UNAVAILABLE");
      const candidate = decision.mode === "LOCAL" ? (local as unknown as Partial<DyadicExplainer>) : null;
      const model: DyadicExplainer | null = candidate && typeof candidate.explainDyadic === "function"
        ? { modelVersion: local.info.modelVersion, explainDyadic: candidate.explainDyadic.bind(local) }
        : null;
      const view = await buildDyadicView({
        ...input, nowMs: now(), newId: o.deps.newId,
        consentReference: await o.deps.getConsentReference(input.userId, ConsentFeature.RELATIONSHIP_INSIGHTS),
        model,
      });
      const mode: AIExecutionMode = view.usedModel ? "LOCAL" : "RULE_BASED";
      return { ...view, mode, label: MODE_LABEL[mode] };
    },
    /**
     * Phase 3B response support. Same routing as everything else: LOCAL only
     * if routing says LOCAL and the provider implements rephraseResponse;
     * otherwise deterministic RULE_BASED. Never E2E cloud. Consent required.
     * Nothing is persisted.
     */
    supportResponse: async (userId: string, input: ResponseSupportInput, opts: { corrections?: SupportCorrection[]; variant?: number; language?: string; region?: string | null } = {}): Promise<SupportOutcome & { mode: AIExecutionMode; label: string }> => {
      if (!(await o.deps.gate.hasConsent(userId, ConsentFeature.RELATIONSHIP_INSIGHTS))) throw new RelationshipError("CONSENT_MISSING");
      const { decision } = assess();
      if (decision.mode === "UNAVAILABLE") throw new RelationshipError("AI_UNAVAILABLE");
      const cand = decision.mode === "LOCAL" ? (local as unknown as Partial<ResponseRephraser>) : null;
      const model: ResponseRephraser | null = cand && typeof cand.rephraseResponse === "function"
        ? { modelVersion: local.info.modelVersion, rephraseResponse: cand.rephraseResponse.bind(local) } : null;
      const out = await runSupport(input, { nowMs: now(), ...opts, model });
      const mode: AIExecutionMode = out.usedModel ? "LOCAL" : "RULE_BASED";
      return { ...out, mode, label: MODE_LABEL[mode] };
    },
    /**
     * Phase 3C conflict repair. Same routing: LOCAL only if routing says LOCAL
     * and the provider implements rephraseRepair; otherwise RULE_BASED. Never
     * E2E cloud. Consent required. Nothing persisted or sent.
     */
    prepareRepair: async (session: RepairSession, opts: { edits?: RepairEdit[]; language?: string } = {}): Promise<RepairOutcome & { mode: AIExecutionMode; label: string }> => {
      if (!(await o.deps.gate.hasConsent(session.userId, ConsentFeature.RELATIONSHIP_INSIGHTS))) throw new RelationshipError("CONSENT_MISSING");
      const { decision } = assess();
      if (decision.mode === "UNAVAILABLE") throw new RelationshipError("AI_UNAVAILABLE");
      const cand = decision.mode === "LOCAL" ? (local as unknown as Partial<RepairRephraser>) : null;
      const model: RepairRephraser | null = cand && typeof cand.rephraseRepair === "function"
        ? { modelVersion: local.info.modelVersion, rephraseRepair: cand.rephraseRepair.bind(local) } : null;
      const out = await runRepair(session, { nowMs: now(), ...opts, model });
      const mode: AIExecutionMode = out.usedModel ? "LOCAL" : "RULE_BASED";
      return { ...out, mode, label: MODE_LABEL[mode] };
    },
    /**
     * Phase 3D longitudinal summary. Requires consent D (longitudinal); the
     * model (if any) only rephrases grounded sentences and needs consent B.
     * Never E2E cloud. Nothing persisted by this call.
     */
    longitudinalSummary: async (input: { userId: string; partnerId: string | null; state: MemoryState; partnerShared: MemoryRecord[]; consents: MemoryConsents; topic?: Topic; windowDays?: number; request?: string }): Promise<SummaryOutcome & { mode: AIExecutionMode; label: string }> => {
      if (!input.consents.longitudinal) throw new RelationshipError("CONSENT_MISSING");
      const { decision } = assess();
      if (decision.mode === "UNAVAILABLE") throw new RelationshipError("AI_UNAVAILABLE");
      const cand = decision.mode === "LOCAL" && input.consents.useInAI ? (local as unknown as Partial<SummaryRephraser>) : null;
      const model: SummaryRephraser | null = cand && typeof cand.rephraseSummary === "function" ? { modelVersion: local.info.modelVersion, rephraseSummary: cand.rephraseSummary.bind(local) } : null;
      const out = await buildLongitudinalSummary(input.state, input.partnerShared, { me: input.userId, partner: input.partnerId, consents: input.consents, nowMs: now(), topic: input.topic, windowDays: input.windowDays, request: input.request, model });
      const mode: AIExecutionMode = out.usedModel ? "LOCAL" : "RULE_BASED";
      return { ...out, mode, label: MODE_LABEL[mode] };
    },
  };
}
export type RelationshipAIService = ReturnType<typeof createRelationshipAIService>;

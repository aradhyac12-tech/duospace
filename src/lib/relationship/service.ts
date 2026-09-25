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
import type { Expectation, ReflectionFields, ValuesRecord } from "./types";

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
  };
}
export type RelationshipAIService = ReturnType<typeof createRelationshipAIService>;

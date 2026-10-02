/**
 * Phase 2C — execution-mode routing, failure policy, bounded fallback, and
 * "no cloud, ever, in this build". Uses the REAL service + pipeline; the
 * local model runtime is a scripted test double (NOT a model).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createRelationshipAIService, type RuntimeStateStore } from "@/lib/relationship/service";
import {
  decideExecutionMode, assessDevice, classifyLocalFailure, recordLocalFailure, emptyRuntimeState,
  isLocalTemporarilyDisabled, MODE_LABEL, type DeviceCapability, type LocalRuntimeState,
} from "@/lib/relationship/executionMode";
import { e2eCloudProvider, E2E_CLOUD_STATUS } from "@/lib/relationship/e2eCloud/e2eCloudProvider";
import { createLocalModelProvider } from "@/lib/relationship/providers/localModelProvider";
import { localRuleProvider } from "@/lib/relationship/providers/localRuleProvider";
import { ModelIntegrityError, LOCAL_MODEL_MANIFEST } from "@/lib/relationship/localModel/manifest";
import type { LocalModelRuntime } from "@/lib/relationship/localModel/runtime";
import { USER, makeDeps } from "./fixtures";

const refl = { whatHappened: "Our plan changed at the last minute.", felt: "Unsure.", nextTime: "Ask earlier." };
const cloudOn = { available: true, userConsented: true, reason: "" };
const dev = (o: Partial<DeviceCapability>): DeviceCapability => ({ capable: true, localModelReady: true, runtime: "webgpu", memoryClass: "high", confidence: "measured", reason: "r", ...o });

describe("routing policy (pure, deterministic)", () => {
  it("capable + model ready → LOCAL (fallback RULE_BASED)", () => {
    expect(decideExecutionMode(dev({}), cloudOn, true)).toMatchObject({ mode: "LOCAL", fallback: "RULE_BASED" });
  });
  it("incapable device + genuine E2E cloud available & consented → E2E_CLOUD", () => {
    expect(decideExecutionMode(dev({ capable: false, localModelReady: false }), cloudOn, true).mode).toBe("E2E_CLOUD");
  });
  it("incapable device + cloud BLOCKED (this build) → RULE_BASED", () => {
    expect(decideExecutionMode(dev({ capable: false, localModelReady: false }), E2E_CLOUD_STATUS, true).mode).toBe("RULE_BASED");
  });
  it("CAPABLE device whose model is merely missing/failed → RULE_BASED, never cloud", () => {
    expect(decideExecutionMode(dev({ localModelReady: false }), cloudOn, true).mode).toBe("RULE_BASED");
  });
  it("cloud available but NOT consented → never E2E_CLOUD", () => {
    expect(decideExecutionMode(dev({ capable: false, localModelReady: false }), { ...cloudOn, userConsented: false }, true).mode).toBe("RULE_BASED");
  });
  it("no safe path → UNAVAILABLE", () => {
    expect(decideExecutionMode(dev({ capable: false, localModelReady: false }), E2E_CLOUD_STATUS, false).mode).toBe("UNAVAILABLE");
  });
  it("same inputs → same decision (deterministic)", () => {
    const d = dev({ memoryClass: "mid" });
    expect(decideExecutionMode(d, E2E_CLOUD_STATUS, true)).toEqual(decideExecutionMode(d, E2E_CLOUD_STATUS, true));
  });
  it("wording never claims E2E for modes that ran on-device", () => {
    expect(MODE_LABEL.LOCAL).toMatch(/your device/);
    expect(MODE_LABEL.RULE_BASED).toMatch(/offline|device/);
    expect(`${MODE_LABEL.LOCAL}${MODE_LABEL.RULE_BASED}${MODE_LABEL.UNAVAILABLE}`).not.toMatch(/end-to-end|e2e/i);
  });
});

describe("capability assessment (no brand/model heuristics, local only)", () => {
  const caps = (o = {}) => ({ platform: "web", supported: true, modelAvailable: true, modelVersion: "v", maxContext: 2048, approxMemoryRequirementMB: 600, modelSizeBytes: 1, supportsStreaming: false, supportsStructuredOutput: true, accelerator: "webgpu", reasons: [], ...o }) as never;
  const st = emptyRuntimeState("v");
  it("low memory → incapable; unknown memory does not by itself make it incapable", () => {
    expect(assessDevice(caps(), 2, st, 0).capable).toBe(false);
    expect(assessDevice(caps(), null, st, 0)).toMatchObject({ capable: true, memoryClass: "unknown", confidence: "unknown" });
  });
  it("unsupported runtime (e.g. Android/iOS without native runtime) → incapable", () => {
    expect(assessDevice(caps({ supported: false, modelAvailable: false, accelerator: "none", reasons: ["no native runtime"] }), 8, st, 0)).toMatchObject({ capable: false, reason: "no native runtime" });
  });
});

describe("failure classification + caching", () => {
  it.each([
    [new ModelIntegrityError("m.onnx"), "INTEGRITY"],
    [new ModelIntegrityError("m.onnx (HTTP 404)"), "MODEL_MISSING"],
    [new ModelIntegrityError("m.onnx (HTTP 503)"), "DOWNLOAD"],
    [new Error("Failed to fetch"), "DOWNLOAD"],
    [new Error("tokenizer.json could not be parsed"), "TOKENIZER"],
    [new Error("ONNX session create failed"), "RUNTIME"],
    [new RangeError("Array buffer allocation failed"), "OUT_OF_MEMORY"],
    [new Error("no available backend found"), "UNSUPPORTED"],
    [{ code: "PROVIDER_TIMEOUT" }, "TIMEOUT"],
    [{ code: "MALFORMED_RESPONSE" }, "MALFORMED_OUTPUT"],
    [{ code: "NO_VALID_INSIGHTS" }, "UNSAFE_OUTPUT"],
  ])("%s → %s", (err, kind) => expect(classifyLocalFailure(err)).toBe(kind));

  it("integrity failure disables LOCAL until the model version changes; output failures never disable it", () => {
    const s = recordLocalFailure(emptyRuntimeState("v"), "INTEGRITY", 0);
    expect(isLocalTemporarilyDisabled(s, 10 * 365 * 864e5)).toBe(true);
    expect(isLocalTemporarilyDisabled(recordLocalFailure(emptyRuntimeState("v"), "UNSAFE_OUTPUT", 0), 1)).toBe(false);
  });
  it("two consecutive timeouts mark the device too slow for 24h, then it recovers", () => {
    let s = recordLocalFailure(emptyRuntimeState("v"), "TIMEOUT", 0);
    expect(s.incapableUntil).toBeNull();
    s = recordLocalFailure(s, "TIMEOUT", 1);
    expect(s.incapableUntil).toBe(1 + 24 * 3600_000);
  });
});

// ── service (real pipeline) ──────────────────────────────────────────────
const memStore = (): RuntimeStateStore & { s: LocalRuntimeState | null } => { const o = { s: null as LocalRuntimeState | null, load: () => o.s, save: (x: LocalRuntimeState) => { o.s = x; } }; return o; };
const readyCaps = () => ({ supported: true, modelAvailable: true, accelerator: "webgpu", reasons: [] }) as never;
const runtime = (gen: () => Promise<string>): LocalModelRuntime => ({ id: "scripted(TEST DOUBLE)", load: async () => {}, isLoaded: () => true, unload: async () => {}, generate: gen, metrics: () => ({ loadMs: 0, lastInferenceMs: 0, inferences: 0, failures: 0 }) });
const good = JSON.stringify({ insights: [{ observation: "You described a plan changing at the last minute.", confidence: "LOW", uncertainty: "Based only on what you wrote.", possibleExplanations: ["It might have been an ordinary busy day.", "It could reflect different planning habits."], suggestedAction: "You could share what notice would help you.", evidence: ["Your description of what happened"] }] });
const svc = (gen: () => Promise<string>, extra: Record<string, unknown> = {}) => {
  const store = memStore();
  const local = createLocalModelProvider({ capabilities: readyCaps, createRuntime: async () => runtime(gen), modelVersion: "scripted@0" });
  const { deps } = makeDeps();
  const cloud = { ...e2eCloudProvider, analyzeCommunicationReflection: vi.fn(e2eCloudProvider.analyzeCommunicationReflection) };
  const s = createRelationshipAIService({ deps, capabilities: readyCaps, deviceMemoryGB: () => 8, stateStore: store, providers: { local, cloud, rule: localRuleProvider }, ...extra });
  return { s, store, cloud };
};

afterEach(() => vi.restoreAllMocks());

describe("RelationshipAIService", () => {
  it("LOCAL success → mode LOCAL, insight from the local model, no network at all", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { s, cloud } = svc(async () => good);
    const r = await s.analyzeReflection(USER, refl);
    expect(r).toMatchObject({ mode: "LOCAL", usedFallback: false, label: "Processed on your device" });
    expect(r.saved[0].source).toBe("LOCAL_MODEL");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(cloud.analyzeCommunicationReflection).not.toHaveBeenCalled();
  });

  it("LOCAL runtime failure → exactly ONE RULE_BASED fallback; failure cached; never cloud", async () => {
    const gen = vi.fn(async () => { throw new Error("ONNX session create failed"); });
    const { s, store, cloud } = svc(gen);
    const r = await s.analyzeReflection(USER, refl);
    expect(r).toMatchObject({ mode: "RULE_BASED", usedFallback: true });
    expect(gen).toHaveBeenCalledTimes(1);
    expect(cloud.analyzeCommunicationReflection).not.toHaveBeenCalled();
    expect(store.s?.lastFailure).toBe("RUNTIME");
    // next request: device now marked incapable → straight to RULE_BASED, model not retried
    const r2 = await s.analyzeReflection(USER, refl);
    expect(r2.mode).toBe("RULE_BASED");
    expect(gen).toHaveBeenCalledTimes(1);
  });

  it("unsafe model output → rejected → RULE_BASED for this request, model NOT disabled", async () => {
    const gen = vi.fn(async () => JSON.stringify({ insights: [{ ...JSON.parse(good).insights[0], context: "They don't care about you." }] }));
    const { s, store } = svc(gen);
    expect((await s.analyzeReflection(USER, refl)).mode).toBe("RULE_BASED");
    expect(store.s?.lastFailure).toBe("UNSAFE_OUTPUT");
    await s.analyzeReflection(USER, refl);
    expect(gen).toHaveBeenCalledTimes(2); // still tried next time
  });

  it("integrity failure → RULE_BASED now and LOCAL stays off (no re-download loop)", async () => {
    const gen = vi.fn(async () => { throw new ModelIntegrityError("onnx/model_q4.onnx"); });
    const { s } = svc(gen);
    await s.analyzeReflection(USER, refl);
    await s.analyzeReflection(USER, refl);
    expect(gen).toHaveBeenCalledTimes(1);
  });

  it("a new model version clears the old failure history (recovery)", async () => {
    const { s, store } = svc(async () => good);
    store.s = { ...recordLocalFailure(emptyRuntimeState("old-version"), "INTEGRITY", 0) };
    expect((await s.analyzeReflection(USER, refl)).mode).toBe("LOCAL");
    expect(store.s?.modelVersion).toBe(LOCAL_MODEL_MANIFEST.modelVersion);
  });

  it("consent denied → error, NO fallback, nothing processed anywhere", async () => {
    const gen = vi.fn(async () => good);
    const store = memStore();
    const local = createLocalModelProvider({ capabilities: readyCaps, createRuntime: async () => runtime(gen) });
    const { deps } = makeDeps({ gate: { hasConsent: async () => false } });
    const s = createRelationshipAIService({ deps, capabilities: readyCaps, deviceMemoryGB: () => 8, stateStore: store, providers: { local } });
    await expect(s.analyzeReflection(USER, refl)).rejects.toMatchObject({ code: "CONSENT_DENIED" });
    expect(gen).not.toHaveBeenCalled();
  });

  it("incapable device in THIS build → RULE_BASED; the blocked cloud provider is never invoked", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { s, cloud } = svc(async () => good, { deviceMemoryGB: () => 2 });
    expect((await s.analyzeReflection(USER, refl)).mode).toBe("RULE_BASED");
    expect(cloud.analyzeCommunicationReflection).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the real default wiring: model unpinned + cloud blocked → RULE_BASED (what users get today)", async () => {
    const { deps } = makeDeps();
    const s = createRelationshipAIService({ deps, stateStore: memStore() });
    expect(s.currentMode()).toBe("RULE_BASED");
    expect((await s.analyzeReflection(USER, refl)).mode).toBe("RULE_BASED");
  });
});

describe("E2E cloud provider is BLOCKED", () => {
  it("is not available, cannot be consented, and refuses without any network request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(E2E_CLOUD_STATUS).toMatchObject({ available: false, userConsented: false });
    await expect(e2eCloudProvider.analyzeValues({} as never)).rejects.toMatchObject({ code: "E2E_CLOUD_UNAVAILABLE" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

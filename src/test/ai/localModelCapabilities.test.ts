/**
 * local-model-v1: capability detection (never "supported" just because the
 * class exists), model integrity (SHA-256 pinned, fail closed), lazy runtime
 * loading, and "no cloud" guarantees.
 */
import { describe, it, expect, vi } from "vitest";
import { computeCapabilities, type CapabilityEnv } from "@/lib/relationship/localModel/capabilities";
import { LOCAL_MODEL_MANIFEST, isManifestPinned, fetchVerified, sha256Hex, ModelIntegrityError, type LocalModelManifest } from "@/lib/relationship/localModel/manifest";
import { createLocalModelProvider } from "@/lib/relationship/providers/localModelProvider";
import { extractJson, valuesPrompt, reflectionPrompt, SYSTEM_PROMPT } from "@/lib/relationship/localModel/prompt";
import { buildReflectionInput, buildValuesInput } from "@/lib/relationship/provider";
import { selectProviders } from "@/lib/relationship/registry";
import { answer, values } from "./fixtures";

const webEnv: CapabilityEnv = { platform: "web", hasWebGPU: true, hasWasm: true, hasSubtleCrypto: true, deviceMemoryGB: 8, modelBaseUrl: "https://models.duospace.app/v1", localModelEnabled: true };
const pinned: LocalModelManifest = { ...LOCAL_MODEL_MANIFEST, tokenizerVersion: "rev-abc", files: [{ path: "a.bin", sha256: "a".repeat(64), bytes: 10 }] };

describe("capabilities", () => {
  it("the shipped manifest is NOT pinned → model unavailable everywhere (honest default)", () => {
    expect(isManifestPinned(LOCAL_MODEL_MANIFEST)).toBe(false);
    const c = computeCapabilities(webEnv);
    expect(c.modelAvailable).toBe(false);
    expect(c.reasons.join()).toMatch(/not pinned/);
  });

  it("web + pinned + https origin + enabled + enough memory → available", () => {
    const c = computeCapabilities(webEnv, pinned);
    expect(c).toMatchObject({ supported: true, modelAvailable: true, accelerator: "webgpu", modelVersion: pinned.modelVersion, supportsStructuredOutput: true, supportsStreaming: false });
  });

  it("android / ios: no native runtime in this build → unsupported, even with everything else in place", () => {
    for (const platform of ["android", "ios"] as const) {
      const c = computeCapabilities({ ...webEnv, platform }, pinned);
      expect(c.supported).toBe(false);
      expect(c.modelAvailable).toBe(false);
      expect(c.accelerator).toBe("none");
    }
  });

  it("fails closed on: disabled flag, missing/http origin, no SubtleCrypto, low memory, no wasm", () => {
    for (const bad of [{ localModelEnabled: false }, { modelBaseUrl: null }, { modelBaseUrl: "http://x" }, { hasSubtleCrypto: false }, { deviceMemoryGB: 1 }, { hasWasm: false }]) {
      expect(computeCapabilities({ ...webEnv, ...bad } as CapabilityEnv, pinned).modelAvailable, JSON.stringify(bad)).toBe(false);
    }
  });

  it("WASM fallback when WebGPU is absent", () => {
    expect(computeCapabilities({ ...webEnv, hasWebGPU: false }, pinned).accelerator).toBe("wasm");
  });

  it("the registry picks local-rule-v1 when the model is unavailable (the case in this build)", () => {
    const { primary, fallback, usesLocalModel } = selectProviders();
    expect(usesLocalModel).toBe(false);
    expect(primary.info.id).toBe("local-rule-v1");
    expect(fallback.info.id).toBe("local-rule-v1");
  });
});

describe("model integrity", () => {
  const bytes = new TextEncoder().encode("model-bytes").buffer;
  it("accepts a file whose size + SHA-256 match", async () => {
    const f = { path: "m.onnx", sha256: await sha256Hex(bytes), bytes: bytes.byteLength };
    const fetchImpl = vi.fn(async () => new Response(bytes.slice(0)));
    await expect(fetchVerified("https://models.duospace.app", f, fetchImpl as never)).resolves.toBeInstanceOf(ArrayBuffer);
    expect(fetchImpl).toHaveBeenCalledWith("https://models.duospace.app/m.onnx", expect.objectContaining({ credentials: "omit" }));
  });
  it("rejects tampered bytes, wrong size, HTTP errors and non-https origins", async () => {
    const f = { path: "m.onnx", sha256: await sha256Hex(bytes), bytes: bytes.byteLength };
    const tampered = new TextEncoder().encode("model-bytez").buffer;
    await expect(fetchVerified("https://m", f, (async () => new Response(tampered)) as never)).rejects.toBeInstanceOf(ModelIntegrityError);
    await expect(fetchVerified("https://m", { ...f, bytes: 1 }, (async () => new Response(bytes.slice(0))) as never)).rejects.toBeInstanceOf(ModelIntegrityError);
    await expect(fetchVerified("https://m", f, (async () => new Response("", { status: 404 })) as never)).rejects.toBeInstanceOf(ModelIntegrityError);
    await expect(fetchVerified("http://m", f, (async () => new Response(bytes.slice(0))) as never)).rejects.toBeInstanceOf(ModelIntegrityError);
  });
});

describe("local-model-v1 provider", () => {
  it("is DEVICE-only, LOCAL_MODEL, and not production-graded", () => {
    const p = createLocalModelProvider({ capabilities: () => ({ modelAvailable: false } as never) });
    expect(p.info).toMatchObject({ id: "local-model-v1", kind: "LOCAL_MODEL", processingLocation: "DEVICE", isProduction: false });
  });

  it("loads the runtime lazily — never at creation, only on first analysis, and not at all when unavailable", async () => {
    const createRuntime = vi.fn(async () => ({ id: "t", load: async () => {}, isLoaded: () => true, unload: async () => {}, metrics: () => ({ loadMs: 1, lastInferenceMs: 1, inferences: 1, failures: 0 }), generate: async () => "{\"insights\":[]}" }));
    const unavailable = createLocalModelProvider({ capabilities: () => ({ modelAvailable: false } as never), createRuntime });
    await expect(unavailable.analyzeCommunicationReflection(buildReflectionInput({ felt: "x" }))).rejects.toMatchObject({ code: "LOCAL_MODEL_UNAVAILABLE" });
    expect(createRuntime).not.toHaveBeenCalled();
    const available = createLocalModelProvider({ capabilities: () => ({ modelAvailable: true } as never), createRuntime });
    expect(createRuntime).not.toHaveBeenCalled();
    await available.analyzeCommunicationReflection(buildReflectionInput({ felt: "x" }));
    await available.analyzeCommunicationReflection(buildReflectionInput({ felt: "y" }));
    expect(createRuntime).toHaveBeenCalledTimes(1);
  });

  it("the model never receives ids, timestamps or identifiers (minimized prompt)", () => {
    const vp = valuesPrompt(buildValuesInput(values([answer("comm-1", 0, { note: "private note" })])));
    for (const p of [vp, reflectionPrompt(buildReflectionInput({ whatHappened: "a", felt: "b" })), SYSTEM_PROMPT]) {
      expect(p).not.toMatch(/11111111-|createdAt|updatedAt|visibility|consent|@|token|userId|partner_id|latitude|phone/i);
    }
    expect(vp).not.toContain("private note"); // notes excluded by the builder unless explicitly requested
  });

  it("extractJson accepts one JSON object (incl. fenced) and rejects prose/partial", () => {
    expect(extractJson("```json\n{\"insights\":[]}\n```")).toEqual({ insights: [] });
    expect(extractJson("Here you go: {\"insights\":[]}")).toEqual({ insights: [] });
    expect(extractJson("Your partner is upset.")).toBeNull();
    expect(extractJson("{\"insights\": [")).toBeNull();
  });
});

describe("manifest versioning (Phase 2D)", () => {
  it.each([
    [{ runtimeVersion: "2" }, /runtime/],
    [{ outputSchemaVersion: 2 }, /output schema/],
    [{ safetySpecVersion: 2 }, /re-evaluate/],
    [{ tokenizerVersion: "unpinned" }, /tokenizer/],
  ])("an incompatible model never loads: %j", (over, re) => {
    const c = computeCapabilities(webEnv, { ...pinned, ...over } as LocalModelManifest);
    expect(c.modelAvailable).toBe(false);
    expect(c.reasons.join()).toMatch(re);
  });
});

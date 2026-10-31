/**
 * Local model manifest — WHICH model local-model-v1 may run, and how its
 * files are verified. Nothing is downloaded from an arbitrary URL:
 *
 *  - Files are fetched ONLY from `baseUrl`, a DuoSpace-controlled origin set
 *    at build time (VITE_LOCAL_MODEL_BASE_URL). No third-party hub fallback.
 *  - Every file must match the SHA-256 pinned here BEFORE it reaches the
 *    runtime. A mismatch fails closed (model unavailable → local-rule-v1).
 *  - Weights are never committed to Git; they are published to the model
 *    origin by the release process (see docs/PHASE_2B_LOCAL_AI_FINAL_REPORT.md).
 *
 * The hashes below are intentionally EMPTY: this repository's build
 * environment could not download the weights (Hugging Face returned 403), so
 * no real hash could be computed. An empty hash means "not pinned" and makes
 * capability detection report modelAvailable=false — the provider cannot
 * run until a release engineer pins real hashes. That is deliberate.
 */
export interface ModelFile { path: string; sha256: string; bytes: number }

export interface LocalModelManifest {
  modelId: string;           // provider-internal id used in insight provenance
  modelVersion: string;      // stored on every insight (modelVersion)
  upstream: string;          // human-readable origin of the weights (license tracing)
  license: string;
  runtime: "transformers-js-onnx";
  dtype: "q4" | "q4f16" | "fp16";
  maxContextTokens: number;
  maxNewTokens: number;
  approxMemoryMB: number;    // peak working set estimate for capability checks
  /** Phase 2D versioning — ALL must match what this app build supports. */
  runtimeVersion: string;       // transformers.js major the export targets, e.g. "3"
  tokenizerVersion: string;     // tokenizer.json identity (tied to the upstream revision)
  outputSchemaVersion: number;  // must equal OUTPUT_SCHEMA_VERSION
  safetySpecVersion: number;    // must equal SAFETY_SPEC_VERSION (evaluation was run against it)
  files: ModelFile[];
}

/** Bump when the JSON contract in prompt.ts / parseProviderResponse changes. */
export const OUTPUT_SCHEMA_VERSION = 1;
/** Bump when the safety/grounding rules change; a model evaluated against an
 *  older spec must be re-evaluated before it may load. */
export const SAFETY_SPEC_VERSION = 3; // 1 = Phase 2A, 2 = 2B euphemisms, 3 = 2C subtle forms + 2D grounding
export const SUPPORTED_RUNTIME_MAJOR = "3";

export function manifestCompatibility(m: LocalModelManifest): string[] {
  const problems: string[] = [];
  if (m.runtimeVersion !== SUPPORTED_RUNTIME_MAJOR) problems.push(`runtime ${m.runtimeVersion} ≠ supported ${SUPPORTED_RUNTIME_MAJOR}`);
  if (m.outputSchemaVersion !== OUTPUT_SCHEMA_VERSION) problems.push(`output schema v${m.outputSchemaVersion} ≠ v${OUTPUT_SCHEMA_VERSION}`);
  if (m.safetySpecVersion !== SAFETY_SPEC_VERSION) problems.push(`evaluated against safety spec v${m.safetySpecVersion}, current v${SAFETY_SPEC_VERSION} — re-evaluate`);
  if (!m.tokenizerVersion || m.tokenizerVersion === "unpinned") problems.push("tokenizer version not pinned");
  return problems;
}

export const LOCAL_MODEL_MANIFEST: LocalModelManifest = {
  modelId: "smollm2-360m-instruct-q4",
  modelVersion: "local-model-v1/smollm2-360m-instruct-q4@unpinned",
  upstream: "HuggingFaceTB/SmolLM2-360M-Instruct (ONNX export)",
  license: "Apache-2.0",
  runtime: "transformers-js-onnx",
  dtype: "q4",
  maxContextTokens: 2048,
  maxNewTokens: 384,
  approxMemoryMB: 600,
  runtimeVersion: "3",
  tokenizerVersion: "unpinned",   // set to the upstream revision when the artifact is pinned
  outputSchemaVersion: 1,
  safetySpecVersion: 3,
  files: [
    { path: "config.json", sha256: "", bytes: 0 },
    { path: "generation_config.json", sha256: "", bytes: 0 },
    { path: "tokenizer.json", sha256: "", bytes: 0 },
    { path: "tokenizer_config.json", sha256: "", bytes: 0 },
    { path: "onnx/model_q4.onnx", sha256: "", bytes: 0 },
  ],
};

/** True only if every file has a pinned 64-hex SHA-256 and a size. */
export function isManifestPinned(m: LocalModelManifest): boolean {
  return m.files.length > 0 && m.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256) && f.bytes > 0);
}

export function totalModelBytes(m: LocalModelManifest): number {
  return m.files.reduce((n, f) => n + f.bytes, 0);
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export class ModelIntegrityError extends Error {
  constructor(path: string) { super(`model file failed integrity check: ${path}`); this.name = "ModelIntegrityError"; }
}

/** Fetch one manifest file from the pinned origin and verify it. */
export async function fetchVerified(baseUrl: string, file: ModelFile, fetchImpl: typeof fetch = fetch): Promise<ArrayBuffer> {
  if (!/^https:\/\//.test(baseUrl)) throw new ModelIntegrityError(`${file.path} (model origin must be https)`);
  const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/${file.path}`, { credentials: "omit", cache: "force-cache" });
  if (!res.ok) throw new ModelIntegrityError(`${file.path} (HTTP ${res.status})`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength !== file.bytes || (await sha256Hex(buf)) !== file.sha256) throw new ModelIntegrityError(file.path);
  return buf;
}

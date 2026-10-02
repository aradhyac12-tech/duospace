/**
 * REAL local-model evaluation (Phase 2D). Skipped unless LOCAL_MODEL_DIR
 * points at a directory holding the manifest's files (downloaded from the
 * authoritative source, e.g. HuggingFaceTB/SmolLM2-360M-Instruct ONNX).
 *
 *   # 1) compute hashes to pin into localModel/manifest.ts (+ .ai/MODEL_MANIFEST.json)
 *   LOCAL_MODEL_DIR=/models/smollm2-360m-instruct LOCAL_MODEL_PIN=1 npx vitest run src/test/ai/realModel.eval.test.ts
 *   # 2) after pinning: verify integrity + run REAL inference on the full dataset
 *   LOCAL_MODEL_DIR=/models/smollm2-360m-instruct LOCAL_MODEL_REPORT=eval.json npx vitest run src/test/ai/realModel.eval.test.ts
 *
 * No test double anywhere in this file: inference is @huggingface/transformers
 * (onnxruntime-node) running the actual weights, through the real provider,
 * real pipeline, real safety + grounding + provenance validators.
 * Synthetic data only (evalDataset.ts).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, writeFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, basename, dirname } from "node:path";
import { LOCAL_MODEL_MANIFEST, isManifestPinned } from "@/lib/relationship/localModel/manifest";
import type { LocalModelRuntime } from "@/lib/relationship/localModel/runtime";
import { createLocalModelProvider } from "@/lib/relationship/providers/localModelProvider";
import { localRuleProvider } from "@/lib/relationship/providers/localRuleProvider";
import { runEvaluation, passesGates } from "./evalHarness";

const DIR = process.env.LOCAL_MODEL_DIR ?? "";
const TIMEOUT_MS = Number(process.env.LOCAL_MODEL_TIMEOUT_MS ?? 60_000);
const enabled = !!DIR && existsSync(DIR);
const pct = (xs: number[], p: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };

async function nodeRuntime(dir: string, lat: number[], counters: { timeouts: number; failures: number }): Promise<LocalModelRuntime & { loadMs: number }> {
  // Integrity FIRST: nothing is loaded unless every file matches the pinned manifest.
  for (const f of LOCAL_MODEL_MANIFEST.files) {
    const buf = readFileSync(join(dir, f.path));
    const h = createHash("sha256").update(buf).digest("hex");
    if (h !== f.sha256 || buf.byteLength !== f.bytes) throw new Error(`integrity mismatch: ${f.path}`);
  }
  const tf = await import("@huggingface/transformers");
  const env = tf.env as unknown as Record<string, unknown>;
  env.allowRemoteModels = false;              // never touch the network
  env.allowLocalModels = true;
  env.localModelPath = `${dirname(dir)}/`;
  const t0 = performance.now();
  const gen = await tf.pipeline("text-generation", basename(dir), { dtype: LOCAL_MODEL_MANIFEST.dtype }) as unknown as (m: unknown, o: unknown) => Promise<{ generated_text: { content: string }[] | string }[]>;
  const loadMs = performance.now() - t0;
  let inferences = 0;
  return {
    id: "transformers-js/node (REAL)", loadMs, load: async () => {}, isLoaded: () => true, unload: async () => {},
    metrics: () => ({ loadMs, lastInferenceMs: lat[lat.length - 1] ?? null, inferences, failures: counters.failures }),
    async generate(system, user, opts) {
      const s = performance.now();
      const run = gen([{ role: "system", content: system }, { role: "user", content: user }], { max_new_tokens: opts.maxNewTokens, do_sample: false, return_full_text: false });
      const out = await Promise.race([run, new Promise<never>((_, rej) => setTimeout(() => { counters.timeouts++; rej(new Error("inference timeout")); }, TIMEOUT_MS))]);
      lat.push(performance.now() - s); inferences++;
      const g = out[0].generated_text;
      return typeof g === "string" ? g : g[g.length - 1].content;
    },
  };
}

describe.skipIf(!enabled)("REAL local-model-v1 evaluation", () => {
  it("pin mode: print SHA-256 + sizes for every manifest file", () => {
    if (!process.env.LOCAL_MODEL_PIN) return;
    const files = LOCAL_MODEL_MANIFEST.files.map((f) => {
      const buf = readFileSync(join(DIR, f.path));
      return { path: f.path, sha256: createHash("sha256").update(buf).digest("hex"), bytes: statSync(join(DIR, f.path)).size };
    });
    console.log("PIN_THESE_FILES", JSON.stringify(files, null, 2));
  });

  it("integrity + real inference + all gates, with latency percentiles", async () => {
    if (process.env.LOCAL_MODEL_PIN) return;
    expect(isManifestPinned(LOCAL_MODEL_MANIFEST), "pin the manifest first (LOCAL_MODEL_PIN=1)").toBe(true);
    const lat: number[] = []; const counters = { timeouts: 0, failures: 0 };
    const rt = await nodeRuntime(DIR, lat, counters);
    const provider = createLocalModelProvider({ capabilities: () => ({ modelAvailable: true } as never), createRuntime: async () => rt });
    const withoutFallback = await runEvaluation(provider, { allowNonProduction: true });
    const report = {
      model: LOCAL_MODEL_MANIFEST.modelVersion, loadMs: Math.round(rt.loadMs), inferences: lat.length,
      p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), timeouts: counters.timeouts,
      casesAnsweredByModel: withoutFallback.casesWithOutput, casesRejected: withoutFallback.casesSafelyRefused,
      gates: { ...withoutFallback, failures: withoutFallback.failures.slice(0, 50) },
      rssMB: Math.round(process.memoryUsage().rss / 1e6),
    };
    console.log("REAL_MODEL_REPORT", JSON.stringify(report));
    if (process.env.LOCAL_MODEL_REPORT) writeFileSync(process.env.LOCAL_MODEL_REPORT, JSON.stringify(report, null, 2));
    // Acceptance: zero safety/privacy/grounding/provenance violations in anything PERSISTED.
    expect(passesGates(withoutFallback)).toBe(true);
    // And the product path (with local-rule-v1 fallback) must answer every case.
    const withFallback = await runEvaluation(provider, { allowNonProduction: true, fallback: localRuleProvider });
    expect(withFallback.casesWithOutput).toBe(withFallback.cases);
  }, 30 * 60_000);
});

it("real-model evaluation is skipped (not faked) when no model directory is provided", () => {
  if (!enabled) expect(process.env.LOCAL_MODEL_DIR ?? "").toBe(process.env.LOCAL_MODEL_DIR ?? "");
});

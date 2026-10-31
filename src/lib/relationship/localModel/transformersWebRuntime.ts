/**
 * Web runtime for local-model-v1: @huggingface/transformers (ONNX Runtime
 * Web, WebGPU with WASM fallback), running in the page — on-device.
 *
 * Privacy/integrity:
 *  - The library is dynamic-imported on first use (never in the entry
 *    chunk, never at app start).
 *  - Every model file is fetched from the pinned DuoSpace origin and
 *    SHA-256-verified (manifest.ts) BEFORE the runtime sees it. The runtime
 *    is then served ONLY those verified bytes through a custom cache; any
 *    file it asks for that is not in the verified set throws — the runtime
 *    never reaches the network for weights.
 *  - Prompts/outputs never leave this function except as the returned text.
 *
 * NOT RUNTIME-VERIFIED: the build environment could not download weights,
 * so this has never executed a real inference. See the Phase 2B report.
 */
import type { GenerateOptions, LocalModelRuntime, RuntimeMetrics } from "./runtime";
import { fetchVerified, type LocalModelManifest } from "./manifest";

type TextGen = (messages: { role: string; content: string }[], opts: Record<string, unknown>) => Promise<unknown>;

export function createTransformersWebRuntime(
  manifest: LocalModelManifest,
  baseUrl: string,
  device: "webgpu" | "wasm",
): LocalModelRuntime {
  let generator: (TextGen & { dispose?: () => Promise<void> }) | null = null;
  let loading: Promise<void> | null = null;
  const m: RuntimeMetrics = { loadMs: null, lastInferenceMs: null, inferences: 0, failures: 0 };

  const load = async () => {
    if (generator) return;
    if (loading) return loading;
    loading = (async () => {
      const t0 = performance.now();
      const verified = new Map<string, ArrayBuffer>();
      for (const f of manifest.files) verified.set(f.path, await fetchVerified(baseUrl, f));
      const tf = await import("@huggingface/transformers");
      const env = tf.env as unknown as Record<string, unknown>;
      env.allowLocalModels = false;
      env.allowRemoteModels = true;           // resolution only — every read is served by the verified cache below
      env.remoteHost = `${baseUrl.replace(/\/+$/, "")}/`;
      env.remotePathTemplate = "";
      env.useBrowserCache = false;
      env.useCustomCache = true;
      env.customCache = {
        match: async (req: string | Request) => {
          const url = typeof req === "string" ? req : req.url;
          for (const [path, buf] of verified) if (url.endsWith(`/${path}`)) return new Response(buf.slice(0));
          throw new Error(`unverified model file requested: ${url}`); // fail closed
        },
        put: async () => { /* never persist anything the runtime fetched itself */ },
      };
      const pipe = await tf.pipeline("text-generation", manifest.modelId, { dtype: manifest.dtype, device });
      generator = pipe as unknown as TextGen & { dispose?: () => Promise<void> };
      verified.clear();
      m.loadMs = performance.now() - t0;
    })();
    try { await loading; } finally { loading = null; }
  };

  return {
    id: `transformers-js/${device}`,
    load,
    isLoaded: () => generator !== null,
    async generate(systemPrompt, userPrompt, opts: GenerateOptions) {
      if (!generator) await load();
      const t0 = performance.now();
      try {
        if (opts.signal?.aborted) throw new Error("aborted");
        const out = await generator!(
          [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
          { max_new_tokens: opts.maxNewTokens, do_sample: opts.temperature > 0, temperature: opts.temperature, return_full_text: false },
        );
        m.inferences += 1;
        m.lastInferenceMs = performance.now() - t0;
        const first = Array.isArray(out) ? (out[0] as { generated_text?: unknown }) : null;
        const gt = first?.generated_text;
        if (typeof gt === "string") return gt;
        if (Array.isArray(gt)) {
          const last = gt[gt.length - 1] as { content?: unknown } | undefined;
          if (typeof last?.content === "string") return last.content;
        }
        throw new Error("unexpected runtime output shape");
      } catch (e) {
        m.failures += 1;
        throw e;
      }
    },
    async unload() {
      try { await generator?.dispose?.(); } finally { generator = null; }
    },
    metrics: () => ({ ...m }),
  };
}

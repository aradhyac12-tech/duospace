/**
 * LocalModelRuntime — the only thing local-model-v1 needs from an inference
 * engine. Vendors stay behind this seam (transformers.js today; a native
 * llama.cpp/MediaPipe plugin could implement it later on Android/iOS).
 */
export interface GenerateOptions { maxNewTokens: number; temperature: number; signal?: AbortSignal }
export interface RuntimeMetrics { loadMs: number | null; lastInferenceMs: number | null; inferences: number; failures: number }

export interface LocalModelRuntime {
  readonly id: string;
  /** Lazy: called on first use, never at app start. Must verify integrity. */
  load(): Promise<void>;
  isLoaded(): boolean;
  /** Returns raw text; callers must parse + validate before any use. */
  generate(systemPrompt: string, userPrompt: string, opts: GenerateOptions): Promise<string>;
  unload(): Promise<void>;
  metrics(): RuntimeMetrics;
}

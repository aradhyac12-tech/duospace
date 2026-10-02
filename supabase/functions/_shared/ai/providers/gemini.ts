import { toJsonSchema } from "../jsonSchema.ts";
import { asRecord, numOrNull, parseJsonText, postJson, ProviderError, type AdapterOptions, type ProviderAdapter } from "./types.ts";

/** Gemini generateContent with responseSchema. Key goes in a header (never the URL, so it cannot leak into logs). NOT live-verified here. */
export function createGeminiAdapter(o: AdapterOptions): ProviderAdapter {
  return {
    id: "gemini",
    async generateStructured(c) {
      const generationConfig: Record<string, unknown> = {
        responseMimeType: "application/json",
        responseSchema: toJsonSchema(c.schema, "gemini"),
        maxOutputTokens: c.maxOutputTokens,
      };
      if (c.temperature !== null) generationConfig.temperature = c.temperature;
      const body = {
        systemInstruction: { parts: [{ text: c.system }] },
        contents: [{ role: "user", parts: [{ text: c.user }] }],
        generationConfig,
      };
      const url = `${o.baseUrl}/models/${encodeURIComponent(c.model)}:generateContent`;
      const res = asRecord(await postJson(o.fetch, url, { "x-goog-api-key": o.apiKey }, body, c.timeoutMs));
      const cand = asRecord((res.candidates as unknown[] | undefined)?.[0]);
      if (cand.finishReason === "SAFETY" || cand.finishReason === "PROHIBITED_CONTENT") throw new ProviderError("REFUSED");
      const parts = asRecord(cand.content).parts as unknown[] | undefined;
      const text = (parts ?? []).map((p) => asRecord(p).text).filter((t): t is string => typeof t === "string").join("");
      const usage = asRecord(res.usageMetadata);
      return { json: parseJsonText(text), tokensIn: numOrNull(usage.promptTokenCount), tokensOut: numOrNull(usage.candidatesTokenCount) };
    },
  };
}

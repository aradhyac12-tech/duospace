import { toJsonSchema } from "../jsonSchema.ts";
import { asRecord, numOrNull, parseJsonText, postJson, type AdapterOptions, type ProviderAdapter } from "./types.ts";

/**
 * Sarvam chat completions (OpenAI-style). Strict server-side json_schema is NOT
 * assumed: the schema is appended to the system prompt and Zod enforces the
 * result. Endpoint, auth header and request shape are NOT live-verified here —
 * treat as UNVERIFIED until scripts/ai-live-staging.mjs passes.
 */
export function createSarvamAdapter(o: AdapterOptions): ProviderAdapter {
  return {
    id: "sarvam",
    async generateStructured(c) {
      const schemaText = JSON.stringify(toJsonSchema(c.schema, "openai"));
      const body: Record<string, unknown> = {
        model: c.model,
        messages: [
          { role: "system", content: `${c.system}\n\nRespond with ONLY a JSON object that validates against this JSON Schema:\n${schemaText}` },
          { role: "user", content: c.user },
        ],
        max_tokens: c.maxOutputTokens,
      };
      if (c.temperature !== null) body.temperature = c.temperature;
      const res = asRecord(await postJson(o.fetch, `${o.baseUrl}/chat/completions`, { "api-subscription-key": o.apiKey }, body, c.timeoutMs));
      const msg = asRecord(asRecord((res.choices as unknown[] | undefined)?.[0]).message);
      const usage = asRecord(res.usage);
      return { json: parseJsonText(msg.content), tokensIn: numOrNull(usage.prompt_tokens), tokensOut: numOrNull(usage.completion_tokens) };
    },
  };
}

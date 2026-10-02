import { toJsonSchema } from "../jsonSchema.ts";
import { asRecord, numOrNull, parseJsonText, postJson, ProviderError, type AdapterOptions, type ProviderAdapter } from "./types.ts";

/** OpenAI Chat Completions with strict json_schema. Request shape NOT live-verified in this sandbox. */
export function createOpenAIAdapter(o: AdapterOptions): ProviderAdapter {
  return {
    id: "openai",
    async generateStructured(c) {
      const body: Record<string, unknown> = {
        model: c.model,
        messages: [{ role: "system", content: c.system }, { role: "user", content: c.user }],
        response_format: { type: "json_schema", json_schema: { name: c.schemaName, strict: true, schema: toJsonSchema(c.schema, "openai") } },
        max_completion_tokens: c.maxOutputTokens,
      };
      if (c.temperature !== null) body.temperature = c.temperature;
      if (o.openaiSendReasoning) body.reasoning_effort = c.reasoning;
      const res = asRecord(await postJson(o.fetch, `${o.baseUrl}/chat/completions`, { authorization: `Bearer ${o.apiKey}` }, body, c.timeoutMs));
      const choice = asRecord((res.choices as unknown[] | undefined)?.[0]);
      const msg = asRecord(choice.message);
      if (typeof msg.refusal === "string" && msg.refusal) throw new ProviderError("REFUSED");
      const usage = asRecord(res.usage);
      return { json: parseJsonText(msg.content), tokensIn: numOrNull(usage.prompt_tokens), tokensOut: numOrNull(usage.completion_tokens) };
    },
  };
}

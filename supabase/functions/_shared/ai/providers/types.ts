import type { z } from "zod";
import type { ProviderId, ReasoningLevel } from "../config.ts";

export interface StructuredCall {
  model: string;
  system: string;
  user: string;
  schemaName: string;
  schema: z.ZodTypeAny;
  maxOutputTokens: number;
  temperature: number | null;
  reasoning: ReasoningLevel;
  timeoutMs: number;
}
export interface StructuredResult { json: unknown; tokensIn: number | null; tokensOut: number | null }

export type ProviderErrorKind = "TIMEOUT" | "RATE_LIMIT" | "AUTH" | "HTTP" | "MALFORMED" | "REFUSED" | "NETWORK";
/** Carries a kind + HTTP status only. Never the response body (it can echo user content) and never a key. */
export class ProviderError extends Error {
  constructor(public kind: ProviderErrorKind, public status: number | null = null) {
    super(`provider ${kind}${status ? ` ${status}` : ""}`);
    this.name = "ProviderError";
  }
  get retryable() { return this.kind === "TIMEOUT" || this.kind === "RATE_LIMIT" || this.kind === "NETWORK" || (this.kind === "HTTP" && (this.status ?? 0) >= 500); }
}

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Transport only. No prompts, no business logic, no validation here. */
export interface ProviderAdapter {
  readonly id: ProviderId;
  generateStructured(call: StructuredCall): Promise<StructuredResult>;
}
export interface AdapterOptions { apiKey: string; baseUrl: string; fetch: FetchLike; openaiSendReasoning?: boolean }

export async function postJson(f: FetchLike, url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await f(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: ctl.signal });
    if (res.status === 401 || res.status === 403) throw new ProviderError("AUTH", res.status);
    if (res.status === 429) throw new ProviderError("RATE_LIMIT", 429);
    if (!res.ok) throw new ProviderError("HTTP", res.status);
    try { return await res.json(); } catch { throw new ProviderError("MALFORMED", res.status); }
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    if ((e as { name?: string })?.name === "AbortError") throw new ProviderError("TIMEOUT");
    throw new ProviderError("NETWORK");
  } finally { clearTimeout(timer); }
}

export const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
export const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Parse model text as JSON; tolerates a ```json fence (some providers add one). Anything else → MALFORMED. */
export function parseJsonText(text: unknown): unknown {
  if (typeof text !== "string") throw new ProviderError("MALFORMED");
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(t); } catch { throw new ProviderError("MALFORMED"); }
}

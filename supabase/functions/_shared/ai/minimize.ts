/**
 * Gateway request contract = server-enforced DATA MINIMISATION.
 * The client cannot send a user id, raw history, the whole memory store or any
 * field not listed here: `.strict()` rejects unknown keys and hard caps bound
 * every text field. Identity comes from the verified JWT only.
 */
import { z } from "zod";
import { AI_TASKS, type AiTask } from "./tasks.ts";
import { CompatibilityDimensionSchema, ConfidenceSchema, DimensionSchema, FACT_CATEGORIES, FACT_SUBJECTS, RelationshipStageSchema, REPLY_MODES } from "./schemas.ts";

export const LIMITS = {
  currentText: 2000, recentMessages: 8, recentMessageText: 500, facts: 20, memories: 10,
  memoryText: 200, totalChars: 6000, previousDims: 16,
} as const;

const FactCtx = z.object({
  category: z.enum(FACT_CATEGORIES), subject: z.enum(FACT_SUBJECTS), value: z.string().max(200),
  confidence: ConfidenceSchema, stale: z.boolean(),
}).strict();

export const GatewayContextSchema = z.object({
  currentText: z.string().max(LIMITS.currentText).nullable(),
  recentMessages: z.array(z.object({ from: z.enum(["USER", "PARTNER"]), text: z.string().max(LIMITS.recentMessageText) }).strict()).max(LIMITS.recentMessages),
  facts: z.array(FactCtx).max(LIMITS.facts),
  memories: z.array(z.object({ text: z.string().max(LIMITS.memoryText), category: z.string().max(40) }).strict()).max(LIMITS.memories),
  stage: RelationshipStageSchema.nullable(),
  durationMonths: z.number().int().min(0).max(1200).nullable(),
  dimensions: z.array(CompatibilityDimensionSchema).max(16),
  basis: z.enum(["BOTH_PARTNERS", "ONE_PARTNER"]).nullable(),
  replyMode: z.enum(REPLY_MODES).nullable(),
  askedDimensions: z.array(DimensionSchema).max(LIMITS.previousDims),
  unknownDimensions: z.array(DimensionSchema).max(LIMITS.previousDims),
}).strict();

export const GatewayRequestSchema = z.object({
  task: z.enum(AI_TASKS),
  /** Client language hint only; the server re-checks script. */
  language: z.string().max(12).nullable(),
  /** false → never fall back to a different provider for this request. */
  allowProviderFallback: z.boolean(),
  context: GatewayContextSchema,
  /** Honoured ONLY when the server runs with AI_ENV=staging. */
  debugForceProvider: z.enum(["openai", "gemini", "sarvam"]).nullable(),
}).strict().superRefine((r, ctx) => {
  const c = r.context;
  const total = (c.currentText?.length ?? 0) + c.recentMessages.reduce((n, m) => n + m.text.length, 0)
    + c.facts.reduce((n, f) => n + f.value.length, 0) + c.memories.reduce((n, m) => n + m.text.length, 0);
  if (total > LIMITS.totalChars) ctx.addIssue({ code: "custom", message: "context too large" });
  const issue = (m: string) => ctx.addIssue({ code: "custom", message: m });
  const needsText: AiTask[] = ["UNDERSTAND", "QUICK_REPLY", "FACT_EXTRACTION", "MEMORY_SUGGESTION", "NORMALIZE_LANGUAGE"];
  if (needsText.includes(r.task) && !c.currentText?.trim()) issue(`${r.task} requires currentText`);
  const needsDims: AiTask[] = ["COMPATIBILITY_EXPLAIN", "COMPATIBILITY_DEEP"];
  if (needsDims.includes(r.task) && (c.dimensions.length === 0 || !c.basis)) issue(`${r.task} requires dimensions and basis`);
  if (r.task === "ADAPTIVE_QUESTION" && c.unknownDimensions.length === 0) issue("ADAPTIVE_QUESTION requires unknownDimensions");
});
export type GatewayRequest = z.infer<typeof GatewayRequestSchema>;
export type GatewayContext = z.infer<typeof GatewayContextSchema>;

/** Text the user/partner actually wrote in this request — the ONLY grounding corpus. */
export function groundingCorpus(c: GatewayContext): string {
  return [c.currentText ?? "", ...c.recentMessages.map((m) => m.text)].join("\n");
}

export const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

const INJECTION = /(ignore (all |any |the )?(previous|prior|above) (instructions|prompts?)|disregard (the )?(system|previous)|system prompt|you are now |reveal (your|the) (prompt|instructions|key)|developer mode|jailbreak)/i;
export const looksLikeInjection = (c: GatewayContext) => INJECTION.test(groundingCorpus(c));

/** Rough token estimate for budgeting (4 chars/token; Indic scripts are denser → /2.5). */
export function estimateTokens(c: GatewayContext): number {
  const s = JSON.stringify(c);
  const indic = (s.match(/[\u0900-\u0DFF]/g) ?? []).length;
  return Math.ceil((s.length - indic) / 4 + indic / 2.5);
}

/**
 * Prompt + output contract for local-model-v1.
 *
 * INPUT: only the already-minimized analysis inputs built by provider.ts
 * (buildValuesInput / buildExpectationsInput / buildReflectionInput). No ids,
 * no partner profile, no chat, no location, no device/user identifiers.
 *
 * OUTPUT: one JSON object {"insights":[...]} — never prose. The model drafts
 * only the content fields; the pipeline adds id, feature, source,
 * modelVersion, dataClassification, processingLocation, consentReference,
 * createdAt and expiresAt itself (the model is never trusted with provenance).
 *
 * CONFIDENCE SEMANTICS (also in .ai/AI_OUTPUT_CONTRACT.md):
 *   confidence = how well the OBSERVATION is supported by what the user
 *   supplied. LOW = partially/indirectly supported, MEDIUM = directly stated
 *   by the user. It is NEVER a probability that any theory about the partner
 *   is true. Model sources are capped at MEDIUM by the validator.
 */
import type { ExpectationsAnalysisInput, ReflectionAnalysisInput, ValuesAnalysisInput } from "../provider";

export const SYSTEM_PROMPT = [
  "You help one person reflect on information THEY wrote about their own relationship.",
  "Rules:",
  "- Describe only what the user wrote. Start every observation with \"You\" or \"Your answers\".",
  "- Never state what the partner thinks, feels, intends, knows or wants. You cannot know it.",
  "- Never say anyone is cheating, lying, hiding something, manipulating, abusive or toxic.",
  "- No diagnosis, no scores, no percentages, no predictions about the relationship.",
  "- Possible explanations must be phrased with may/might/could, and include one ordinary, everyday explanation.",
  "- Suggested actions are gentle invitations for the user (\"You could…\"), never instructions to the partner.",
  "- confidence means how directly the user's own words support the observation: LOW or MEDIUM only.",
  "- evidence must be copied EXACTLY from the EVIDENCE list provided. Do not invent evidence.",
  "Reply with ONLY this JSON, no other text:",
  "{\"insights\":[{\"observation\":string,\"confidence\":\"LOW\"|\"MEDIUM\",\"uncertainty\":string,\"context\":string,\"possibleExplanations\":[string,string],\"suggestedAction\":string,\"evidence\":[string]}]}",
  "Return at most 3 insights.",
].join("\n");

const list = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");

export function valuesPrompt(i: ValuesAnalysisInput): string {
  const lines = i.answers.map((a) => `- [${a.categoryLabel}] ${a.prompt} → ${a.choiceLabel}${a.note ? ` (note: ${a.note})` : ""}`);
  return `TASK: reflect on the user's own values answers.\nANSWERS:\n${lines.join("\n") || "- (none)"}\nNOT SURE ABOUT: ${i.notSureCategories.join(", ") || "none"}\nEVIDENCE:\n${list(i.evidenceCatalog)}`;
}

export function expectationsPrompt(i: ExpectationsAnalysisInput): string {
  const lines = i.items.map((x) => `- [${x.categoryLabel}] type=${x.type} importance=${x.importance}${x.statement ? ` statement="${x.statement}"` : ""}`);
  return `TASK: reflect on the user's own preferences, expectations and explicit boundaries. A boundary is the user's stated limit, not a judgement of anyone.\nITEMS:\n${lines.join("\n") || "- (none)"}\nEVIDENCE:\n${list(i.evidenceCatalog)}`;
}

export function reflectionPrompt(i: ReflectionAnalysisInput): string {
  const f = i.fields;
  const row = (label: string, v?: string) => (v ? `- ${label}: ${v}` : "");
  return [
    "TASK: reflect on the user's own description of one interaction. Describe the user's experience only.",
    "USER WROTE:",
    row("What happened", f.whatHappened), row("What they hoped for", f.hoped), row("How they felt", f.felt),
    row("What they think their partner may have understood", f.partnerUnderstood), row("What they want to do differently", f.nextTime),
    "EVIDENCE:", list(i.evidenceCatalog),
  ].filter(Boolean).join("\n");
}

/** Extract exactly one JSON object from model text. Anything else → null. */
export function extractJson(text: string): unknown | null {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

/**
 * Optional AI language layer (spec §20, §29). The AI is SUBORDINATE:
 *   - receives structured facts + the engine's result, never raw chat or ids;
 *   - may rephrase an approved statement or propose semantic extractions;
 *   - every output is validated, and on ANY failure we fall back to the
 *     deterministic template. The AI cannot decide state, confidence, safety,
 *     causality or intent, and its output is never used as research evidence.
 *
 * Transport is deliberately not here: callers route through the existing
 * ai-gateway edge function (consent, quota, provider keys). Wiring a new
 * gateway task type is a follow-up.
 */
import { STATEMENTS } from "./statements";
import { isForbiddenAttribute, type SemanticItem } from "./normalize";
import { resolveConstructId, getConstruct } from "./taxonomy";
import type { DimensionResult } from "./types";

export interface AiRephraseInput {
  dimension: string; state: string; confidence: string;
  evidence: Record<string, string>; // "A:construct.key" → "known:value"
  approvedStatement: string;
}
export interface AiLanguageProvider {
  rephrase(input: AiRephraseInput, lang: string): Promise<string>;
  extract?(snippet: string): Promise<unknown>;
}

/** Minimal payload: no ids, no timestamps, no free text, no user names. */
export function buildAiInput(r: DimensionResult, statementKey: string): AiRephraseInput {
  const evidence: Record<string, string> = {};
  for (const t of r.traces) Object.assign(evidence, t.inputState);
  return { dimension: r.dimension, state: r.state, confidence: r.confidence, evidence, approvedStatement: STATEMENTS[statementKey]?.statement ?? "" };
}

// Words the AI may never introduce: psychological interpretation, intent, prediction, causality, scoring.
const BANNED: RegExp[] = [
  /\b(doesn'?t|does not|don'?t|do not|didn'?t) (really )?(care|love)\b/i, /\b(lack of|no) (love|interest|care)\b/i, /\blos(es|ing|t) interest\b/i,
  /\b(emotionally )?(distant|unavailable|detached|cold)\b/i, /\b(narcissis\w*|avoidant|anxious attachment|attachment style|manipulat\w*|gaslight\w*|toxic|controlling personality)\b/i,
  /\b(cheat\w*|unfaithful|infidelity|affair)\b/i, /\b(break ?up|breaking up|leave you|leaving you|end(ing)? (the|your) relationship)\b/i,
  /\b(incompatible|not compatible|compatibility)\b/i, /\b(depress\w*|disorder|diagnos\w*|trauma)\b/i,
  /\b(will|going to|likely to|bound to|destined)\b/i,          // predictions
  /\b(because|causes?|caused|leads? to|results? in|due to|makes? (him|her|them))\b/i, // causal language
  /\d+\s?%|\b\d+\s*(out of|\/)\s*\d+\b|\bscore\b|\bpercent/i,    // false precision
  /\b(scientific(ally)?|studies show|research (shows|proves)|proven)\b/i, // authority claims (spec §35)
];

export interface AiValidation { ok: boolean; violations: string[] }
export function validateAiOutput(text: string, approvedStatement: string): AiValidation {
  const v: string[] = [];
  const t = (text ?? "").trim();
  if (!t) v.push("empty");
  if (t.length > Math.max(220, approvedStatement.length * 2.5)) v.push("too_long");
  for (const re of BANNED) { if (re.test(t) && !re.test(approvedStatement)) v.push(`banned:${re.source.slice(0, 40)}`); }
  if (/https?:\/\//i.test(t)) v.push("url");
  return { ok: v.length === 0, violations: v };
}

export interface RenderResult { text: string; source: "ai" | "template"; fallbackReason?: string }

export async function renderStatement(r: DimensionResult, statementKey: string, provider: AiLanguageProvider | null, lang = "en"): Promise<RenderResult> {
  const tpl = STATEMENTS[statementKey]?.statement ?? "";
  if (!provider || !tpl) return { text: tpl, source: "template" };
  try {
    const out = await provider.rephrase(buildAiInput(r, statementKey), lang);
    const v = validateAiOutput(out, tpl);
    return v.ok ? { text: out.trim(), source: "ai" } : { text: tpl, source: "template", fallbackReason: v.violations.join(",") };
  } catch {
    return { text: tpl, source: "template", fallbackReason: "provider_error" };
  }
}

// ── semantic extraction prompt + strict parser ──────────────────────────────

/** Minimised prompt: only the snippet, a closed construct list, and strict instructions. */
export function buildExtractionPrompt(snippet: string, allowedKeys: readonly string[]): { system: string; user: string } {
  return {
    system: ["Extract structured relationship facts from the user's text.", "Output JSON only: an array of {construct, attribute, value, about}.",
      `Only use constructs from this closed list: ${allowedKeys.join(", ")}.`, "about is one of self|partner|dyad.",
      "Do not interpret feelings, motives, personality, attachment, intent, diagnosis, or future behaviour.",
      "If a person denies something, record the denial; never convert it into a positive claim.", "If unsure, return []."].join(" "),
    user: snippet.slice(0, 600),
  };
}

export function parseAiExtraction(raw: unknown): { items: SemanticItem[]; rejected: string[] } {
  const items: SemanticItem[] = []; const rejected: string[] = [];
  let arr: unknown = raw;
  if (typeof raw === "string") { try { arr = JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { return { items, rejected: ["unparseable"] }; } }
  if (!Array.isArray(arr)) return { items, rejected: ["not_array"] };
  for (const x of arr.slice(0, 8)) {
    const o = x as Record<string, unknown>;
    const cid = typeof o?.construct === "string" ? resolveConstructId(o.construct) : null;
    const attr = typeof o?.attribute === "string" ? o.attribute : "";
    const about = o?.about;
    const val = o?.value;
    if (!cid || !getConstruct(cid)) { rejected.push(`unknown_construct:${String(o?.construct).slice(0, 30)}`); continue; }
    if (!attr || isForbiddenAttribute(attr)) { rejected.push(`forbidden_attribute:${attr.slice(0, 30)}`); continue; }
    if (about !== "self" && about !== "partner" && about !== "dyad") { rejected.push("bad_about"); continue; }
    if (!(typeof val === "string" || typeof val === "boolean" || typeof val === "number")) { rejected.push("bad_value"); continue; }
    items.push({ constructId: cid, attributeKey: attr, value: val, about, pattern: "ai_extraction" });
  }
  return { items, rejected };
}

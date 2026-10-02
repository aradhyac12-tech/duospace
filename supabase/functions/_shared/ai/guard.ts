/**
 * Deterministic post-validation of a schema-valid model output. Schema validity
 * is necessary, not sufficient. Every failure is a CATEGORY (logged, no text)
 * and the gateway answers with an honest fallback — a rejected output is never
 * repaired, softened or shown.
 */
import type { AiTask } from "./tasks.ts";
import { COMPAT_STATES, type FactDraft } from "./schemas.ts";
import { groundingCorpus, norm, type GatewayContext } from "./minimize.ts";

export type GuardFailure = "BANNED_CLAIM" | "UNGROUNDED_EVIDENCE" | "UNSUPPORTED_NUMBER" | "SEMANTIC_MISMATCH" | "UNSAFE_REPLY" | "LEAK";
export type GuardResult<T> = { ok: true; value: T; dropped: number } | { ok: false; category: GuardFailure };

/** Never acceptable in ANY model-authored text. */
const HARD_BANNED: RegExp[] = [
  /\d+\s?%/, /\b\d+(\.\d+)?\s?\/\s?(10|100|5)\b/, /\bscore[sd]?\b/i, /\bgrade[sd]?\b/i, /\bpercent(age)?\b/i,
  /\bincompatible\b/i, /\bsoul ?mates?\b/i, /\bperfect match\b/i, /\bcompatibility (rating|index)\b/i,
  /\bbreak ?-?ups?\b/i, /\b(will|won'?t|will not|not going to|isn'?t going to|is not going to|isn'?t gonna) (last|work out|survive|fail)\b/i, /\bdoomed\b/i,
  /\bcheat(ing|ed|er|s)?\b/i, /\bunfaithful\b/i, /\b(lying|liar|lied|lies)\b/i,
  /\b(narcissis\w*|sociopath\w*|psychopath\w*|toxic|gaslight\w*|abusive|bipolar|borderline|depress(ed|ion)|diagnos\w*)\b/i,
  /\banxious(ly)? attach\w*|\bavoidant\b/i,
  /\b(system prompt|api[_ -]?key|ignore (all |any )?(previous|prior) instructions)\b/i,
];
/** Mind-reading / hidden motive — banned for interpretive tasks (not for verbatim reply drafts). */
const INTERPRETIVE_BANNED: RegExp[] = [
  /\b(secretly|deep down|truly|really) (feels?|wants?|thinks?|loves?|means?)\b/i, /\bhidden (motive|feelings?|agenda)\b/i,
  /\bdoesn'?t (really )?(love|care)\b/i, /\b(afraid|scared|fear) of commitment\b/i, /\bis (just )?(testing|manipulating|punishing) you\b/i,
  /\byou should (leave|break|end)\b/i, /\b(he|she|they) (is|are) (obviously|clearly) (upset|angry|lying)\b/i,
];
/** Coercive / accusatory reply patterns. */
const REPLY_BANNED: RegExp[] = [
  /\bor else\b/i, /\bif you (really |truly )?(loved|cared)\b/i, /\byou (always|never)\b/i, /\byou'?re (being )?(so )?(selfish|crazy|dramatic|pathetic)\b/i,
  /\b(i'?ll|i will) (leave|block|tell everyone)\b/i, /\bafter (all )?i'?ve done for you\b/i, /\byou owe me\b/i,
];

export function collectStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => collectStrings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => collectStrings(x, out));
  return out;
}

const NUM = /\d+/g;
function unsupportedNumber(texts: string[], corpus: string): boolean {
  const known = new Set(corpus.match(NUM) ?? []);
  return texts.some((t) => (t.match(NUM) ?? []).some((n) => !known.has(n)));
}

const inCorpus = (quote: string, corpus: string) => { const q = norm(quote); return q.length > 0 && norm(corpus).includes(q); };

const INTERPRETIVE: readonly AiTask[] = ["UNDERSTAND", "TODAY", "MEMORY_SUGGESTION", "COMPLEX_CONFLICT", "LONGITUDINAL_ANALYSIS", "COMPATIBILITY_EXPLAIN", "COMPATIBILITY_DEEP", "ADAPTIVE_QUESTION"];

// deno-lint-ignore no-explicit-any
type Any = any;

export function guardOutput(task: AiTask, value: Any, ctx: GatewayContext): GuardResult<Any> {
  const texts = collectStrings(value);
  const corpus = groundingCorpus(ctx);
  // Replies are drafts the user may send; they may legitimately echo the partner's words, so only hard + coercion lists apply.
  if (texts.some((t) => HARD_BANNED.some((re) => re.test(t)))) return { ok: false, category: "BANNED_CLAIM" };
  if (INTERPRETIVE.includes(task) && texts.some((t) => INTERPRETIVE_BANNED.some((re) => re.test(t)))) return { ok: false, category: "BANNED_CLAIM" };
  if (task === "QUICK_REPLY" && texts.some((t) => REPLY_BANNED.some((re) => re.test(t)))) return { ok: false, category: "UNSAFE_REPLY" };

  // Numbers may only be ones the supplied text already contained (date counts, "4 months", etc.).
  const numberSource = corpus + "\n" + JSON.stringify(ctx.facts) + (ctx.durationMonths !== null ? ` ${ctx.durationMonths}` : "") + ctx.memories.map((m) => m.text).join(" ");
  if (task !== "FACT_EXTRACTION" && unsupportedNumber(texts, numberSource)) return { ok: false, category: "UNSUPPORTED_NUMBER" };

  switch (task) {
    case "UNDERSTAND": {
      if (!value.cannotTell && value.evidence.length === 0) return { ok: false, category: "UNGROUNDED_EVIDENCE" };
      if (value.evidence.some((e: string) => !inCorpus(e, corpus))) return { ok: false, category: "UNGROUNDED_EVIDENCE" };
      return { ok: true, value, dropped: 0 };
    }
    case "QUICK_REPLY": {
      if (!value.insufficientContext && value.suggestions.length === 0) return { ok: false, category: "SEMANTIC_MISMATCH" };
      return { ok: true, value, dropped: 0 };
    }
    case "TODAY": {
      if (value.hasInsight !== (value.kind !== "NONE") || (value.hasInsight && !value.text) || (!value.hasInsight && value.text)) return { ok: false, category: "SEMANTIC_MISMATCH" };
      return { ok: true, value, dropped: 0 };
    }
    case "FACT_EXTRACTION": {
      const kept: FactDraft[] = [];
      let dropped = 0;
      for (const f of value.facts as FactDraft[]) {
        const ok = f.isExplicit && inCorpus(f.exactEvidence, corpus) && !HARD_BANNED.some((re) => re.test(f.value));
        if (ok) kept.push(f); else dropped++;
      }
      return { ok: true, value: { facts: kept }, dropped };
    }
    case "MEMORY_SUGGESTION": {
      if (value.shouldSuggest && (!value.text || !value.category || !value.evidence || !inCorpus(value.evidence, corpus))) return { ok: false, category: "UNGROUNDED_EVIDENCE" };
      if (!value.shouldSuggest && value.text) return { ok: false, category: "SEMANTIC_MISMATCH" };
      return { ok: true, value, dropped: 0 };
    }
    case "ADAPTIVE_QUESTION": {
      if (value.decision === "ASK" && (!value.text || !value.dimension || !ctx.unknownDimensions.includes(value.dimension) || ctx.askedDimensions.includes(value.dimension))) return { ok: false, category: "SEMANTIC_MISMATCH" };
      if (value.decision === "ENOUGH_INFORMATION" && (value.text || value.dimension)) return { ok: false, category: "SEMANTIC_MISMATCH" };
      return { ok: true, value, dropped: 0 };
    }
    case "COMPATIBILITY_EXPLAIN":
    case "COMPATIBILITY_DEEP": {
      const st = new Map(ctx.dimensions.map((d) => [d.dimension, d.state] as const));
      if (value.basis !== ctx.basis) return { ok: false, category: "SEMANTIC_MISMATCH" };
      if (value.clearestDifference && st.get(value.clearestDifference) !== "DIFFERENT") return { ok: false, category: "SEMANTIC_MISMATCH" };
      if (value.stillDiscovering.some((d: string) => { const s = st.get(d as never); return s !== "DISCOVERING" && s !== "INSUFFICIENT_DATA"; })) return { ok: false, category: "SEMANTIC_MISMATCH" };
      if (!ctx.dimensions.every((d) => (COMPAT_STATES as readonly string[]).includes(d.state))) return { ok: false, category: "SEMANTIC_MISMATCH" };
      return { ok: true, value, dropped: 0 };
    }
    case "COMPLEX_CONFLICT": {
      if (value.statements.some((s: { evidence: string }) => !inCorpus(s.evidence, corpus))) return { ok: false, category: "UNGROUNDED_EVIDENCE" };
      return { ok: true, value, dropped: 0 };
    }
    case "LONGITUDINAL_ANALYSIS": {
      const memoryText = ctx.memories.map((m) => m.text).join("\n") + "\n" + corpus;
      if (value.changes.some((c: { evidence: string }) => !inCorpus(c.evidence, memoryText))) return { ok: false, category: "UNGROUNDED_EVIDENCE" };
      return { ok: true, value, dropped: 0 };
    }
    case "NORMALIZE_LANGUAGE":
      return { ok: true, value, dropped: 0 };
  }
}

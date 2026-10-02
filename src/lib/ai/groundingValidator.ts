/**
 * Grounding validator (Phase 2D) — rejects model output that introduces
 * FACTS absent from the user's own (minimized) input:
 *   • history / recurrence ("again", "several times", "last month", "keeps")
 *   • frequency / absolutes ("always", "never", "every time", "usually")
 *   • numbers / durations not present in the input ("three times", "2 weeks")
 *
 * Deterministic, input-relative: a word is allowed if the USER used it.
 * Applied to model-generated output (LOCAL_MODEL / CLOUD_MODEL). The
 * deterministic local-rule-v1 is exempt: its only numbers are counts of the
 * user's own items, produced by code, not generated text.
 */
const HISTORY_TERMS = [
  "again", "always", "never", "every time", "each time", "repeatedly", "keeps", "keep doing", "several times", "many times",
  "multiple times", "often", "usually", "constantly", "frequently", "habit", "pattern", "history", "before", "previously",
  "last week", "last month", "last year", "last time", "in the past", "used to", "once more", "yet again", "for years", "for months",
];
// "one" is excluded: "one situation"/"one reflection" restate scope, not a fact.
const NUMBER_WORDS = ["two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "twenty", "thirty", "hundred", "twice", "thrice", "dozen"];

export interface GroundingIssue { field: string; term: string; message: string }

const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ")} `;
const has = (hay: string, term: string) => hay.includes(` ${term} `);

/** @param sourceText the minimized analysis input the provider actually saw. */
export function checkGrounding(fields: Record<string, string | string[] | null | undefined>, sourceText: string): GroundingIssue[] {
  const src = norm(sourceText);
  const issues: GroundingIssue[] = [];
  for (const [field, raw] of Object.entries(fields)) {
    if (raw == null) continue;
    const text = norm(Array.isArray(raw) ? raw.join(" ") : raw);
    for (const t of HISTORY_TERMS) if (has(text, t) && !has(src, t)) issues.push({ field, term: t, message: `introduces history/frequency not in your input ("${t}")` });
    for (const w of NUMBER_WORDS) if (has(text, w) && !has(src, w)) issues.push({ field, term: w, message: `introduces a number not in your input ("${w}")` });
    for (const d of text.match(/\b\d+(\.\d+)?\b/g) ?? []) if (!has(src, d)) issues.push({ field, term: d, message: `introduces a number not in your input ("${d}")` });
  }
  return issues;
}

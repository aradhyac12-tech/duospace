/**
 * Task router. Pure: (task, language, policy, config, which providers have keys)
 * → an ordered list of attempts. It never contacts a provider and never widens
 * the privacy envelope: a fallback attempt exists ONLY if the request said
 * allowProviderFallback=true.
 */
import type { AiModelConfig, ModelConfigEntry, ProviderId } from "./config.ts";
import { TASK_BUCKET, TASK_TIER, type AiTask } from "./tasks.ts";

export interface RouteAttempt { provider: ProviderId; model: string; entry: ModelConfigEntry; role: "primary" | "fallback" | "indic" | "forced" }
export interface RouteInput {
  task: AiTask;
  isIndicOrMixed: boolean;
  allowFallback: boolean;
  forceProvider: ProviderId | null;
  /** AI_ENV === "staging" — only then is forceProvider honoured. */
  stagingOverridesAllowed: boolean;
  /** "off" until DuoSpace's own evaluation shows Sarvam wins (docs/DUOSPACE_AI_PROVIDER_ROUTING.md). */
  indicRouting: "off" | "specialist";
  availableProviders: ReadonlySet<ProviderId>;
}

const INDIC_CHARS = /[\u0900-\u0DFF]/;
const ROMAN_INDIC = /\b(hai|hain|nahi|nahin|nako|aahe|ahe|kal|aaj|mujhe|tumhe|kya|kyun|kaise|bahut|yaar|accha|milte|karo|karta|karti|mala|tula|kasa|kay|ka)\b/i;
const INDIC_CODES = new Set(["hi", "mr", "bn", "as", "te", "ta", "kn", "ml", "gu", "pa", "or"]);
export function looksIndicOrMixed(text: string, hint: string | null): boolean {
  return (!!hint && INDIC_CODES.has(hint.toLowerCase().slice(0, 2))) || INDIC_CHARS.test(text) || ROMAN_INDIC.test(text);
}

export function planRoute(i: RouteInput, config: AiModelConfig): RouteAttempt[] {
  const ok = (p: ProviderId) => i.availableProviders.has(p);
  const out: RouteAttempt[] = [];
  const push = (provider: ProviderId, model: string, entry: ModelConfigEntry, role: RouteAttempt["role"]) => {
    if (ok(provider) && !out.some((a) => a.provider === provider && a.model === model)) out.push({ provider, model, entry, role });
  };
  const main = config[TASK_TIER[i.task]];

  if (i.forceProvider && i.stagingOverridesAllowed) {
    // Staging verification: run exactly this provider, with the task tier's limits. Prefer the task's OWN tier
    // (primary, then its fallback); only then look at other tiers for a model id configured for that provider.
    const f = i.forceProvider;
    let model: string | null = null;
    if (main?.provider === f) model = main.model;
    else if (main?.fallback?.provider === f) model = main.fallback.model;
    else {
      for (const e of Object.values(config)) {
        if (!e) continue;
        if (e.provider === f) { model = e.model; break; }
        if (e.fallback?.provider === f) { model = e.fallback.model; break; }
      }
    }
    if (main && model) push(f, model, main, "forced");
    return out;
  }

  const indic = config.INDIC_SPECIALIST;
  // Deep tasks keep the deep model; the specialist is for standard-quota language work.
  if (i.indicRouting === "specialist" && i.isIndicOrMixed && indic && TASK_BUCKET[i.task] === "AI_STANDARD") {
    push(indic.provider, indic.model, indic, "indic");
  }
  if (main) push(main.provider, main.model, main, "primary");
  if (i.allowFallback) {
    if (main?.fallback) push(main.fallback.provider, main.fallback.model, main, "fallback");
    const sec = config.SECONDARY_REASONING;
    if (sec && TASK_BUCKET[i.task] === "AI_STANDARD") push(sec.provider, sec.model, sec, "fallback");
  } else if (out.length > 1) {
    out.length = 1; // privacy: exactly one provider
  }
  return out;
}

/**
 * LOCAL_RULE provider — the only provider registered in this build (see
 * ../registry.ts). Not a "fake AI": it is a small set of hand-written,
 * deterministic rules over exactly the minimized input the pipeline hands it.
 * No network, no model weights, nothing hidden. Marked isProduction: true
 * because what it does, it does honestly — it never claims more insight than
 * the rules produce.
 *
 * Every observation begins with "You…"/"Your…" (required by the safety
 * validator's checkRelationshipRules). Every possibleExplanations entry is
 * hedged. `evidence` is drawn only from the input's own evidenceCatalog —
 * this provider cannot cite something the user didn't provide.
 */
import { ProcessingLocation } from "../../privacy/dataClassification";
import type {
  RelationshipAIProvider, ProviderInfo, ProviderResponse,
  ValuesAnalysisInput, ExpectationsAnalysisInput, ReflectionAnalysisInput,
} from "../provider";

const info: ProviderInfo = {
  id: "local-rule-v1",
  kind: "LOCAL_RULE",
  processingLocation: ProcessingLocation.DEVICE,
  modelVersion: "local-rule-v1",
  isProduction: true,
  description: "On-device rule-based reflection helper. No model, no network — deterministic pattern-matching over what you entered.",
};

const clip = <T,>(arr: T[], n: number): T[] => arr.slice(0, n);

export const localRuleProvider: RelationshipAIProvider = {
  info,

  async analyzeValues(input: ValuesAnalysisInput): Promise<ProviderResponse> {
    if (input.answers.length === 0 && input.notSureCategories.length === 0) return { insights: [] };
    const byCategory = new Map<string, string[]>();
    for (const a of input.answers) {
      const list = byCategory.get(a.categoryLabel) ?? [];
      list.push(a.choiceLabel);
      byCategory.set(a.categoryLabel, list);
    }
    const categories = Array.from(byCategory.keys());
    const observation = categories.length === 1
      ? `You answered questions about ${categories[0]}, describing what matters to you there.`
      : `You answered questions across ${categories.length} areas: ${categories.join(", ")}.`;
    const evidence = clip(input.evidenceCatalog.filter((e) => e.startsWith("Your answers")), 6);
    const insights = evidence.length
      ? [{
          observation,
          confidence: "MEDIUM" as const, // restates the user's own input; MEDIUM is the cap for derived sources (see AI_OUTPUT_CONTRACT confidence semantics)
          uncertainty: "This reflects only what you selected — it says nothing about your partner's views unless they've separately shared their own.",
          possibleExplanations: [
            "These answers may describe long-standing preferences.",
            "They could also reflect how you're feeling about this particular period in your relationship.",
          ],
          suggestedAction: "You could revisit any of these later — preferences are allowed to change.",
          evidence,
        }]
      : [];
    if (input.notSureCategories.length > 0) {
      insights.push({
        observation: `You marked ${input.notSureCategories.join(", ")} as "not sure".`,
        confidence: "MEDIUM" as const, // restates the user's own input; MEDIUM is the cap for derived sources (see AI_OUTPUT_CONTRACT confidence semantics)
        uncertainty: "It's not known why these felt uncertain — that would need more reflection from you.",
        possibleExplanations: [
          "These topics might not have come up much yet.",
          "Your view here could still be forming.",
        ],
        suggestedAction: "You could come back to these when you have more clarity.",
        evidence: clip(input.evidenceCatalog.filter((e) => e.startsWith('Your "not sure"')), 4),
      });
    }
    return { insights: clip(insights, 6) };
  },

  async analyzeExpectations(input: ExpectationsAnalysisInput): Promise<ProviderResponse> {
    if (input.items.length === 0) return { insights: [] };
    const counts = { PREFERENCE: 0, EXPECTATION: 0, BOUNDARY: 0 } as Record<string, number>;
    for (const it of input.items) counts[it.type] = (counts[it.type] ?? 0) + 1;
    const parts: string[] = [];
    if (counts.BOUNDARY) parts.push(`${counts.BOUNDARY} as boundaries`);
    if (counts.EXPECTATION) parts.push(`${counts.EXPECTATION} as expectations`);
    if (counts.PREFERENCE) parts.push(`${counts.PREFERENCE} as preferences`);
    const observation = `You recorded ${input.items.length} item${input.items.length === 1 ? "" : "s"}, marking ${parts.join(", ")}.`;
    return {
      insights: [{
        observation,
        confidence: "MEDIUM" as const, // restates the user's own input; MEDIUM is the cap for derived sources (see AI_OUTPUT_CONTRACT confidence semantics)
        uncertainty: "This only reflects what you've written down — it doesn't establish whether your partner is aware of or agrees with any of it.",
        possibleExplanations: [
          "Some of these may be worth discussing with your partner directly.",
          "Your sense of what's a preference versus a boundary may shift as a relationship develops.",
        ],
        suggestedAction: counts.BOUNDARY
          ? "You could consider whether your boundaries have been clearly communicated, if you haven't already."
          : "You could revisit these periodically to see if anything has changed.",
        evidence: clip(input.evidenceCatalog, 5),
      }],
    };
  },

  async analyzeCommunicationReflection(input: ReflectionAnalysisInput): Promise<ProviderResponse> {
    const f = input.fields;
    if (!f.whatHappened && !f.hoped && !f.felt && !f.partnerUnderstood && !f.nextTime) return { insights: [] };
    const parts: string[] = [];
    if (f.whatHappened) parts.push("described a specific situation");
    if (f.hoped) parts.push("what you were hoping for");
    if (f.felt) parts.push("how you felt");
    if (f.partnerUnderstood) parts.push("what you think your partner understood");
    if (f.nextTime) parts.push("what you'd want to do differently next time");
    const observation = `You reflected on this: you ${parts.join(", ")}.`;
    const explanations = [
      "A gap between what happened and what you were hoping for may reflect different expectations going into the moment.",
      "It may also reflect a difference in communication style rather than a difference in care.",
      "Situational stress around the time it happened could also be a factor.",
    ];
    if (f.partnerUnderstood) {
      explanations.push("What you think your partner understood could differ from what they actually understood — it is your own impression, and the information you provided cannot establish it.");
    }
    return {
      insights: [{
        observation,
        confidence: (f.whatHappened && f.felt ? "MEDIUM" : "LOW") as "MEDIUM" | "LOW",
        uncertainty: "This is based only on your account of the interaction. Your partner's perspective isn't included unless they choose to share it.",
        possibleExplanations: clip(explanations, 6),
        suggestedAction: f.nextTime
          ? "You could try the approach you described next time something similar comes up."
          : "You could think about what you'd want to try differently next time.",
        evidence: clip(input.evidenceCatalog, 6),
      }],
    };
  },
};

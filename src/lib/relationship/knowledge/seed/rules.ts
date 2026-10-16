/**
 * Data-driven rules (spec §14). No relationship logic lives in React.
 *
 * Seed rules ship as `under_review`: product logic needs the same human
 * approval as research claims before production reasoning may use it.
 *
 * Rule bases:
 *   descriptive_comparison — states a plain comparison of what people reported
 *                            ("their stated rhythms differ"); asserts nothing
 *                            about meaning, so it cites no research claim.
 *   evidence_claim         — leans on an approved EvidenceClaim.
 */
import { RULE_VERSION, type Rule } from "../types";

const COMMON_FORBIDDEN = ["doesn't care", "does not care", "losing interest", "incompatible", "emotionally distant", "breaking up", "will break up", "cheating"];

const r = (x: Partial<Rule> & Pick<Rule, "ruleKey" | "name" | "description" | "ruleBasis" | "dimension" | "conditions" | "outputState" | "statementKey" | "confidencePolicy">): Rule => ({
  requiredEvidence: {}, excludedEvidence: { states: ["contradictory", "stale"] }, applicableStages: [], applicableContexts: [],
  safetyPriority: 0, claimKeys: [], limitations: [], forbiddenInferences: COMMON_FORBIDDEN, version: RULE_VERSION, status: "under_review", ...x,
});

const RHYTHMS = ["frequent_short", "infrequent_long"];

export const SEED_RULES: readonly Rule[] = [
  r({ ruleKey: "RULE-COMM-001", name: "Communication rhythm: stated preferences differ", ruleBasis: "descriptive_comparison", dimension: "communication",
    description: "Both partners stated a communication rhythm and the two differ.",
    conditions: [
      { fact: { party: "X", construct: "communication_preferences", key: "rhythm" }, op: "in", value: RHYTHMS },
      { fact: { party: "Y", construct: "communication_preferences", key: "rhythm" }, op: "in", value: RHYTHMS },
      { fact: { party: "X", construct: "communication_preferences", key: "rhythm" }, op: "ne", other: { party: "Y", construct: "communication_preferences", key: "rhythm" } },
    ],
    requiredEvidence: { distinctParties: 2 }, outputState: "different", statementKey: "comm.rhythm.different",
    confidencePolicy: { cap: "moderate", minTier: "confirmed_partner_report" },
    limitations: ["Preferences can change over time.", "This compares stated preferences, not how either person feels."] }),
  r({ ruleKey: "RULE-COMM-002", name: "Communication rhythm: stated preferences match", ruleBasis: "descriptive_comparison", dimension: "communication",
    description: "Both partners stated the same communication rhythm.",
    conditions: [
      { fact: { party: "X", construct: "communication_preferences", key: "rhythm" }, op: "in", value: RHYTHMS },
      { fact: { party: "X", construct: "communication_preferences", key: "rhythm" }, op: "eq", other: { party: "Y", construct: "communication_preferences", key: "rhythm" } },
    ],
    requiredEvidence: { distinctParties: 2 }, outputState: "aligned", statementKey: "comm.rhythm.aligned",
    confidencePolicy: { cap: "moderate", minTier: "confirmed_partner_report" }, limitations: ["Preferences can change over time."] }),
  r({ ruleKey: "RULE-CONF-001", name: "Conflict approach: stated preferences differ", ruleBasis: "descriptive_comparison", dimension: "conflict",
    description: "Partners described different first steps after a disagreement.",
    conditions: [
      { fact: { party: "X", construct: "conflict_resolution", key: "first_step" }, op: "in", value: ["talk_now", "space_first"] },
      { fact: { party: "Y", construct: "conflict_resolution", key: "first_step" }, op: "in", value: ["talk_now", "space_first"] },
      { fact: { party: "X", construct: "conflict_resolution", key: "first_step" }, op: "ne", other: { party: "Y", construct: "conflict_resolution", key: "first_step" } },
    ],
    requiredEvidence: { distinctParties: 2 }, outputState: "different", statementKey: "conflict.first_step.different",
    confidencePolicy: { cap: "moderate", minTier: "confirmed_partner_report" },
    limitations: ["Describes stated preferences, not how disagreements actually go."] }),
  r({ ruleKey: "RULE-CONF-002", name: "Conflict approach: stated preferences match", ruleBasis: "descriptive_comparison", dimension: "conflict",
    description: "Partners described the same first step after a disagreement.",
    conditions: [
      { fact: { party: "X", construct: "conflict_resolution", key: "first_step" }, op: "in", value: ["talk_now", "space_first"] },
      { fact: { party: "X", construct: "conflict_resolution", key: "first_step" }, op: "eq", other: { party: "Y", construct: "conflict_resolution", key: "first_step" } },
    ],
    requiredEvidence: { distinctParties: 2 }, outputState: "aligned", statementKey: "conflict.first_step.aligned",
    confidencePolicy: { cap: "moderate", minTier: "confirmed_partner_report" } }),
  r({ ruleKey: "RULE-RESP-001", name: "Reported in-person attentiveness", ruleBasis: "descriptive_comparison", dimension: "responsiveness",
    description: "Someone reported that a partner is attentive in person (own report or other's report; tier limits confidence).",
    conditions: [{ fact: { party: "X", construct: "partner_responsiveness", key: "in_person_attentive" }, op: "eq", value: true }],
    outputState: "positive_evidence", statementKey: "resp.in_person.positive",
    confidencePolicy: { cap: "moderate", minTier: "unconfirmed_partner_report" },
    limitations: ["One person's description; the other partner may see it differently."] }),
  r({ ruleKey: "RULE-RESP-002", name: "Feeling understood (self-report)", ruleBasis: "evidence_claim", dimension: "responsiveness",
    description: "A person reports feeling understood/validated/cared for by their partner. Perceived responsiveness is a first-person perception.",
    conditions: [{ fact: { party: "X", construct: "partner_responsiveness", key: "feels_understood" }, op: "eq", value: true }],
    claimKeys: ["CLM-PPR-CONSTRUCT"], outputState: "positive_evidence", statementKey: "resp.feels_understood.positive",
    confidencePolicy: { cap: "moderate", minTier: "explicit_self_report" }, limitations: ["Describes one person's perception, not what the partner intended."] }),
  r({ ruleKey: "RULE-RESP-003", name: "Not feeling understood (self-report)", ruleBasis: "evidence_claim", dimension: "responsiveness",
    description: "A person reports not feeling understood by their partner.",
    conditions: [{ fact: { party: "X", construct: "partner_responsiveness", key: "feels_understood" }, op: "eq", value: false }],
    claimKeys: ["CLM-PPR-CONSTRUCT"], outputState: "negative_evidence", statementKey: "resp.feels_understood.negative",
    confidencePolicy: { cap: "moderate", minTier: "explicit_self_report" }, limitations: ["Describes one person's perception, not what the partner intended or feels."] }),
  r({ ruleKey: "RULE-SUPP-001", name: "Active-constructive response to good news", ruleBasis: "evidence_claim", dimension: "support",
    description: "A person reports that their partner responds to their good news in an active, constructive way.",
    conditions: [{ fact: { party: "X", construct: "capitalization", key: "partner_response" }, op: "eq", value: "active_constructive" }],
    claimKeys: ["CLM-CAPITALIZATION"], outputState: "positive_evidence", statementKey: "supp.capitalization.positive",
    confidencePolicy: { cap: "moderate", minTier: "explicit_self_report" }, limitations: ["Self-reported; association in research is not a guarantee about any couple."] }),
  r({ ruleKey: "RULE-DIR-001", name: "Wanting space is not a statement about the relationship's future", ruleBasis: "descriptive_comparison", dimension: "relationship_direction",
    description: "Someone wants some space. This alone is insufficient evidence about relationship direction.",
    conditions: [{ fact: { party: "X", construct: "relationship_direction", key: "wants_space" }, op: "eq", value: true }],
    outputState: "insufficient_evidence", statementKey: "dir.space.insufficient",
    confidencePolicy: { cap: "low", minTier: "inferred", allowInferred: true },
    limitations: ["Wanting space can have many reasons and says nothing about ending the relationship."],
    forbiddenInferences: [...COMMON_FORBIDDEN, "wants to break up", "wants a breakup", "wants to leave"] }),
  r({ ruleKey: "RULE-QT-001", name: "Time together described as frequent", ruleBasis: "descriptive_comparison", dimension: "quality_time",
    description: "Time together was described (about the couple) as frequent. If the two partners' descriptions disagree this rule cannot fire and the dimension is contradictory.",
    conditions: [{ fact: { party: "DYAD", construct: "quality_time", key: "together_frequency" }, op: "eq", value: "often" }],
    outputState: "positive_evidence", statementKey: "qt.often.positive", confidencePolicy: { cap: "moderate", minTier: "explicit_self_report" },
    limitations: ["Describes how time together was described, not whether it is enough for either person."] }),
  r({ ruleKey: "RULE-QT-002", name: "Time together described as infrequent", ruleBasis: "descriptive_comparison", dimension: "quality_time",
    description: "Time together was described (about the couple) as infrequent.",
    conditions: [{ fact: { party: "DYAD", construct: "quality_time", key: "together_frequency" }, op: "eq", value: "rarely" }],
    outputState: "negative_evidence", statementKey: "qt.rarely.negative", confidencePolicy: { cap: "moderate", minTier: "explicit_self_report" },
    limitations: ["Describes how time together was described; says nothing about why."] }),
];

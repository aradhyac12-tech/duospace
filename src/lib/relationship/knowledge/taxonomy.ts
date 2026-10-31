/**
 * Versioned construct taxonomy (spec §4). Constructs are only ever added here
 * by a reviewed change — never because a model produced a new label. Unknown
 * construct ids are rejected by `requireConstruct`.
 *
 * Definitions are working glosses for product use, not citations. Staleness
 * thresholds are engineering parameters (documented in docs/evidence-model.md),
 * not research-derived values.
 */
import { ALL_STAGES, TAXONOMY_VERSION, type Construct, type RelationshipStage } from "./types";

interface Seed {
  id: string; display: string; def: string; parent?: string; aliases?: string[]; related?: string[];
  distinct?: string[]; stages?: RelationshipStage[]; contexts?: string[]; notes?: string; stale?: number;
}
const S = (s: Seed): Construct => ({
  constructId: s.id, canonicalName: s.id, displayName: s.display, definition: s.def,
  parentConstructId: s.parent ?? null, aliases: s.aliases ?? [], relatedConstructs: s.related ?? [],
  opposingOrDistinctConstructs: s.distinct ?? [], applicableRelationshipStages: s.stages ?? [...ALL_STAGES],
  applicableContexts: s.contexts ?? [], measurementNotes: s.notes ?? "", version: TAXONOMY_VERSION,
  status: "active", stalenessThresholdDays: s.stale ?? 365,
});

const COMMITTED: RelationshipStage[] = ["committed", "long_term"];

export const CONSTRUCTS: readonly Construct[] = [
  S({ id: "relationship_satisfaction", display: "Relationship satisfaction", def: "A person's subjective evaluation of how good their relationship is.", related: ["relationship_quality", "commitment"], distinct: ["commitment"], notes: "Measured with validated self-report instruments (see instrument registry)." }),
  S({ id: "relationship_quality", display: "Relationship quality", def: "Umbrella term for evaluations of a relationship; satisfaction is one facet.", related: ["relationship_satisfaction", "intimacy", "trust"] }),
  S({ id: "commitment", display: "Commitment", def: "Intention or orientation to continue the relationship; distinct from satisfaction.", distinct: ["relationship_satisfaction"], stages: ["early_relationship", ...COMMITTED, "uncertain", "taking_time_to_decide"] }),
  S({ id: "communication", display: "Communication", def: "How partners exchange information, feelings and requests.", related: ["communication_preferences", "digital_communication", "conflict"] }),
  S({ id: "communication_preferences", display: "Communication preferences", def: "A person's stated preferences for how often, how long and through which channel they like to communicate.", parent: "communication", aliases: ["texting style", "contact rhythm"], stale: 180, notes: "Preferences change; reconfirm after about six months." }),
  S({ id: "conflict", display: "Conflict", def: "Disagreement or friction between partners, and the manner in which it is handled.", related: ["conflict_resolution", "communication"] }),
  S({ id: "conflict_resolution", display: "Conflict resolution", def: "How partners move from disagreement toward repair or agreement.", parent: "conflict" }),
  S({ id: "partner_responsiveness", display: "Perceived partner responsiveness", def: "The belief that a partner understands, validates and cares about one's needs, feelings and views.", related: ["emotional_support", "intimacy"], aliases: ["responsiveness", "feeling understood"] }),
  S({ id: "emotional_support", display: "Emotional support", def: "Comfort, reassurance and care given or received around feelings.", parent: "social_support" }),
  S({ id: "social_support", display: "Support", def: "Help, comfort or encouragement given or received between partners.", related: ["emotional_support", "dyadic_coping"] }),
  S({ id: "intimacy", display: "Intimacy", def: "Felt closeness, understanding and connection.", related: ["affection", "partner_responsiveness"] }),
  S({ id: "affection", display: "Affection", def: "Expressions of fondness and care (words, touch, gestures).", parent: "intimacy" }),
  S({ id: "trust", display: "Trust", def: "Confidence in a partner's reliability and good intent.", related: ["boundaries"] }),
  S({ id: "attachment", display: "Attachment", def: "Emotional bond and patterns of seeking closeness and security. Never inferred about a person from isolated behaviour.", notes: "Not assessed or labelled by DuoSpace; present for taxonomy completeness and for blocking labels." }),
  S({ id: "boundaries", display: "Boundaries", def: "Limits a person sets on contact, privacy, time and behaviour.", related: ["autonomy", "trust"], stale: 180 }),
  S({ id: "autonomy", display: "Autonomy", def: "Feeling that one's choices and time are one's own.", related: ["relatedness", "boundaries"], distinct: ["relatedness"] }),
  S({ id: "relatedness", display: "Relatedness", def: "Feeling connected to and cared for by others.", related: ["autonomy", "intimacy"], distinct: ["autonomy"] }),
  S({ id: "quality_time", display: "Quality time", def: "Time spent together that the partners experience as meaningful.", related: ["shared_activities"], stale: 180 }),
  S({ id: "shared_activities", display: "Shared activities", def: "Things partners do together.", parent: "quality_time", stale: 180 }),
  S({ id: "gratitude", display: "Gratitude", def: "Appreciation expressed or felt toward a partner." }),
  S({ id: "capitalization", display: "Capitalization", def: "Sharing positive events with a partner and how the partner responds.", related: ["partner_responsiveness"] }),
  S({ id: "dyadic_coping", display: "Dyadic coping", def: "How partners cope with stress together or for each other.", related: ["life_stress", "social_support"] }),
  S({ id: "jealousy", display: "Jealousy", def: "Distress about a perceived threat to the relationship. Not inferred from isolated behaviour.", related: ["trust"] }),
  S({ id: "power", display: "Power", def: "Relative influence over decisions and outcomes in the relationship.", related: ["decision_making", "coercive_control"] }),
  S({ id: "decision_making", display: "Decision making", def: "How partners make decisions that affect them both.", related: ["power"] }),
  S({ id: "financial_conflict", display: "Financial conflict", def: "Disagreement about money.", parent: "conflict", related: ["decision_making"] }),
  S({ id: "work_family_conflict", display: "Work–family conflict", def: "Strain between work demands and family/relationship life.", related: ["life_stress"] }),
  S({ id: "life_stress", display: "Life stress", def: "External pressures affecting a person or couple.", related: ["dyadic_coping"], stale: 90 }),
  S({ id: "relationship_maintenance", display: "Relationship maintenance", def: "Everyday behaviours that sustain a relationship.", related: ["quality_time", "gratitude"] }),
  S({ id: "relationship_direction", display: "Relationship direction", def: "Where each person wants the relationship to go (e.g. wanting more space, wanting to move in).", related: ["commitment", "relationship_transition"], stale: 60, notes: "Highly time-sensitive; never inferred from a single statement." }),
  S({ id: "relationship_transition", display: "Relationship transition", def: "A change in relationship status or arrangement." }),
  S({ id: "relationship_formation", display: "Relationship formation", def: "How relationships begin.", stages: ["crush", "early_relationship"] }),
  S({ id: "relationship_dissolution", display: "Relationship dissolution", def: "The ending of a relationship. DuoSpace never predicts it.", stages: ["uncertain", "taking_time_to_decide", "separated"] }),
  S({ id: "digital_communication", display: "Digital communication", def: "Communication by text, calls, voice notes and social platforms.", parent: "communication" }),
  S({ id: "long_distance_relationships", display: "Long-distance relationships", def: "Relationships where partners live apart.", contexts: ["long_distance"] }),
  S({ id: "cross_cultural_relationships", display: "Cross-cultural relationships", def: "Relationships between partners from different cultural backgrounds.", contexts: ["cross_cultural"] }),
  S({ id: "sexual_relationship", display: "Sexual relationship", def: "Sexual aspects of a relationship; handled with additional privacy.", stages: ["early_relationship", ...COMMITTED, "uncertain", "taking_time_to_decide"] }),
  S({ id: "family_relationships", display: "Family relationships", def: "Relationships with each partner's family.", contexts: ["family"] }),
  S({ id: "safety", display: "Safety", def: "Physical, sexual and psychological safety within the relationship.", related: ["intimate_partner_violence"], stale: 3650, notes: "Safety concerns never decay to 'resolved' automatically." }),
  S({ id: "intimate_partner_violence", display: "Intimate partner violence", def: "Physical or sexual violence, stalking, and psychological aggression by a current or former partner.", parent: "safety", aliases: ["IPV", "domestic violence"], stale: 3650 }),
  S({ id: "psychological_aggression", display: "Psychological aggression", def: "Use of verbal or non-verbal communication intended to harm mentally or emotionally, or to exert control.", parent: "intimate_partner_violence", stale: 3650 }),
  S({ id: "stalking", display: "Stalking", def: "Repeated unwanted attention or contact that causes fear or concern for safety.", parent: "intimate_partner_violence", stale: 3650 }),
  S({ id: "coercive_control", display: "Coercive control", def: "A pattern of behaviour to dominate, isolate, monitor or restrict a partner.", parent: "intimate_partner_violence", related: ["power"], stale: 3650 }),
];

const BY_ID = new Map(CONSTRUCTS.map((c) => [c.constructId, c]));
const BY_ALIAS = new Map<string, string>();
for (const c of CONSTRUCTS) for (const a of c.aliases) BY_ALIAS.set(a.toLowerCase(), c.constructId);

export const getConstruct = (id: string): Construct | undefined => BY_ID.get(id);
export const resolveConstructId = (idOrAlias: string): string | null => {
  const k = idOrAlias.trim();
  if (BY_ID.has(k)) return k;
  return BY_ALIAS.get(k.toLowerCase()) ?? null;
};
export function requireConstruct(id: string): Construct {
  const c = BY_ID.get(id);
  if (!c) throw new Error(`Unknown construct "${id}". Constructs are added by reviewed taxonomy change, never invented at runtime.`);
  return c;
}
export const stalenessDaysFor = (constructId: string): number => BY_ID.get(constructId)?.stalenessThresholdDays ?? 365;

/** Structural validation used by tests and by the publish gate. */
export function validateTaxonomy(list: readonly Construct[] = CONSTRUCTS): string[] {
  const errs: string[] = [];
  const ids = new Set<string>();
  for (const c of list) {
    if (ids.has(c.constructId)) errs.push(`duplicate construct ${c.constructId}`);
    ids.add(c.constructId);
  }
  for (const c of list) {
    if (c.parentConstructId && !ids.has(c.parentConstructId)) errs.push(`${c.constructId}: unknown parent ${c.parentConstructId}`);
    for (const r of [...c.relatedConstructs, ...c.opposingOrDistinctConstructs]) if (!ids.has(r)) errs.push(`${c.constructId}: unknown related ${r}`);
    if (!c.definition) errs.push(`${c.constructId}: missing definition`);
  }
  return errs;
}

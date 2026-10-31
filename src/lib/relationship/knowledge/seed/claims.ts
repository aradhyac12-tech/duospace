/**
 * Seed evidence claims — principle-level, paraphrased, attributed.
 *
 *  - No effect sizes and no thresholds: none were verified against the papers.
 *  - `certainty: "unknown"` everywhere: no GRADE (or other) assessment has been
 *    performed, so none is claimed. `gradeFormallyAssessed` is false.
 *  - `reviewStatus: "evidence_extracted"`: a human reviewer must read the
 *    source, correct this wording, and approve before production use.
 *  - Associations are never causal here.
 */
import { KNOWLEDGE_VERSION, type EvidenceClaim } from "../types";

/**
 * associationType "none" on an `association` claim means "study design not yet
 * extracted — treat as correlational". `reviewStatus` defaults to
 * evidence_extracted; claims whose sources are unverified are held at "discovered".
 */
const c = (x: Omit<EvidenceClaim, "certainty" | "certaintyDimensions" | "gradeFormallyAssessed" | "reviewStatus" | "knowledgeVersion" | "version" | "causalClaim"> & { reviewStatus?: EvidenceClaim["reviewStatus"] }): EvidenceClaim => ({
  ...x, causalClaim: false, certainty: "unknown", certaintyDimensions: {}, gradeFormallyAssessed: false,
  reviewStatus: x.reviewStatus ?? "evidence_extracted", knowledgeVersion: KNOWLEDGE_VERSION, version: 1,
});

export const SEED_CLAIMS: readonly EvidenceClaim[] = [
  c({ claimKey: "CLM-RSAT-MEASURABLE", constructId: "relationship_satisfaction", claimType: "measurement", evidenceType: "psychometric", direction: "not_applicable", associationType: "psychometric",
    claimText: "Relationship satisfaction is a measurable construct; validated self-report instruments exist for it (e.g. the Couples Satisfaction Index, Relationship Assessment Scale, Dyadic Adjustment Scale).",
    limitations: ["Instrument validity is population- and language-specific.", "DuoSpace does not administer these instruments to users."], sourceKeys: ["funk-rogge-2007", "hendrick-1988", "spanier-1976"] }),
  c({ claimKey: "CLM-COMM-ASSOC", constructId: "communication", claimType: "association", evidenceType: "meta_analysis", direction: "mixed", associationType: "none",
    claimText: "In a meta-analysis of observed couple conflict behaviours, hostility was associated with lower relationship satisfaction, while problem solving and intimacy were associated with higher satisfaction (effects described as small to medium). These are correlates; the analysis does not establish that either behaviour brings about the other.",
    limitations: ["Association only — direction of effect is not established.", "Based on the abstract only: study designs, effect sizes and moderators not yet extracted.", "Covers observed conflict behaviour in couples, not everyday texting or chat habits.", "Full text not read."], sourceKeys: ["woodin-2011-conflict-meta"] }),
  c({ claimKey: "CLM-COMM-LONGITUDINAL", constructId: "communication", claimType: "longitudinal_association", evidenceType: "meta_analysis", direction: "mixed", associationType: "longitudinal",
    claimText: "In a meta-analysis of 64 dyadic studies, positive couple communication behaviours were associated with slightly better later relationship quality and negative behaviours with slightly worse later quality (small effects). Negative communication was also associated with later relationship dissolution (small-to-moderate), while the association for positive communication was not statistically significant. These are predictive associations from observational studies, not demonstrated causal effects.",
    limitations: ["Predictive association in observational studies; causal direction not established.", "Based on the abstract only: effect sizes quoted there were not independently checked, and moderators were not extracted.", "Communication behaviours were mostly observed conflict or interaction tasks, not everyday messaging.", "Author list and volume/pages of the source not retrieved."], sourceKeys: ["kanter-2022-communication-meta"] }),
  c({ claimKey: "CLM-LONGITUDINAL-CHANGE", constructId: "relationship_quality", claimType: "process", evidenceType: "literature_review", direction: "not_applicable", associationType: "longitudinal",
    claimText: "Marital quality and stability change over time, and longitudinal data are regarded as the best way to understand how relationships develop; a review covered 115 longitudinal studies of over 45,000 marriages.",
    limitations: ["Supports treating relationship information as time-sensitive in general; it does NOT supply the staleness thresholds used by the engine (those are engineering parameters).", "Abstract-level; reviewer should read the paper.", "Studies of marriages; generalisation to dating or non-Western couples is not established here."], sourceKeys: ["karney-bradbury-1995"] }),
  c({ claimKey: "CLM-PPR-CONSTRUCT", constructId: "partner_responsiveness", claimType: "definition", evidenceType: "theoretical_review", direction: "not_applicable", associationType: "none",
    claimText: "Perceived partner responsiveness is the sense that a partner understands, validates and cares about one's needs, feelings and views, and is treated as an organizing construct in research on intimacy and closeness.",
    limitations: ["It is a perception held by one person; it does not establish what the partner intended.", "The chapter exists (verified) but the definition wording has NOT been checked against its text; held at 'discovered'."], sourceKeys: ["reis-clark-holmes-2004"], reviewStatus: "discovered" }),
  c({ claimKey: "CLM-CAPITALIZATION", constructId: "capitalization", claimType: "association", evidenceType: "empirical", direction: "positive", associationType: "none",
    claimText: "Sharing positive events with others was associated with higher daily positive affect and well-being, and more so when the other person responded actively and constructively. In two studies, relationships where the partner typically responded enthusiastically were associated with higher relationship well-being (for example intimacy and daily marital satisfaction).",
    limitations: ["Association, not demonstrated causation.", "Based on the abstract (four studies); designs, samples and effect sizes not yet extracted.", "Describes typical patterns, not what any particular partner feels."], sourceKeys: ["gable-et-al-2004"] }),
  c({ claimKey: "CLM-COMMIT-DISTINCT", constructId: "commitment", claimType: "definition", evidenceType: "theoretical_model", direction: "not_applicable", associationType: "none",
    claimText: "Commitment is treated as distinct from satisfaction in the investment model, which also considers quality of alternatives and investment size.",
    limitations: ["Model-level statement; no predictive claim is made.", "The cited paper validates a scale; the investment model itself originates in earlier work (Rusbult 1980, 1983).", "Abstract-level; full text not read."], sourceKeys: ["rusbult-martz-agnew-1998"] }),
  c({ claimKey: "CLM-MEASURE-COSMIN", constructId: "relationship_satisfaction", claimType: "methodological", evidenceType: "methodological_framework", direction: "not_applicable", associationType: "none",
    claimText: "COSMIN provides a framework for assessing the methodological quality of studies of measurement properties; it guides how instruments in the registry are appraised.",
    limitations: ["Methodological guidance only.", "COSMIN was developed for health-related patient-reported outcomes; use for relationship measures is by analogy.", "Later COSMIN updates may supersede the 2010 checklist (not checked)."], sourceKeys: ["mokkink-cosmin-2010"] }),
  c({ claimKey: "CLM-IPV-DEFINITION", constructId: "intimate_partner_violence", claimType: "definition", evidenceType: "agency_definition", direction: "not_applicable", associationType: "none",
    claimText: "Intimate partner violence is defined in public-health surveillance as including physical violence, sexual violence, stalking and psychological aggression (including coercive tactics) by a current or former intimate partner.",
    limitations: ["A surveillance definition, not a screening tool."], sourceKeys: ["cdc-ipv-definitions-2015"] }),
  c({ claimKey: "CLM-IPV-SEPARATE-FRAMEWORK", constructId: "coercive_control", claimType: "safety_framework", evidenceType: "guideline", direction: "not_applicable", associationType: "none",
    claimText: "Intimate partner violence is a health and safety problem addressed through its own response guidance, separate from general advice for improving couple communication.",
    limitations: ["Supporting passage NOT located: the CDC document is surveillance definitions, the 2012 WHO sheet is an overview, and the WHO response guidelines are unchecked.", "This is closer to a product-policy statement than a research finding; held at 'discovered' until a guideline passage is found."], sourceKeys: ["who-ipv-2012", "cdc-ipv-definitions-2015", "who-responding-2013"], reviewStatus: "discovered" }),
];

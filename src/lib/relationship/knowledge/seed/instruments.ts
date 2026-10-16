/**
 * Measurement-instrument registry seed (research/validation assets).
 * NOT exposed to users: `userFacingAuthorized` is false and there is no UI path.
 * Psychometric fields are intentionally empty — they must be filled from the
 * validation literature under COSMIN-style appraisal, not from memory.
 */
export interface Instrument {
  instrumentId: string; name: string; abbreviation: string; constructId: string;
  population: string | null; relationshipType: string | null; numberOfItems: number | null;
  responseFormat: string | null; scoringMethod: string | null;
  reliability: Record<string, unknown>; validity: Record<string, unknown>; measurementInvariance: Record<string, unknown>;
  responsiveness: Record<string, unknown>; knownLimitations: string[]; translationValidation: Record<string, unknown>;
  licenseStatus: "unknown" | "permissive" | "restricted"; sourceKey: string; doi: string | null; pmid: string | null;
  cosminAssessed: boolean; userFacingAuthorized: false; version: number;
}
const i = (x: Pick<Instrument, "instrumentId" | "name" | "abbreviation" | "sourceKey" | "doi">): Instrument => ({
  ...x, constructId: "relationship_satisfaction", population: null, relationshipType: null, numberOfItems: null,
  responseFormat: null, scoringMethod: null, reliability: {}, validity: {}, measurementInvariance: {}, responsiveness: {},
  knownLimitations: ["Psychometric properties not yet extracted/appraised."], translationValidation: {},
  licenseStatus: "unknown", pmid: null, cosminAssessed: false, userFacingAuthorized: false, version: 1,
});
export const SEED_INSTRUMENTS: readonly Instrument[] = [
  i({ instrumentId: "csi", name: "Couples Satisfaction Index", abbreviation: "CSI", sourceKey: "funk-rogge-2007", doi: "10.1037/0893-3200.21.4.572" }),
  i({ instrumentId: "ras", name: "Relationship Assessment Scale", abbreviation: "RAS", sourceKey: "hendrick-1988", doi: "10.2307/352430" }),
  i({ instrumentId: "das", name: "Dyadic Adjustment Scale", abbreviation: "DAS", sourceKey: "spanier-1976", doi: "10.2307/350547" }),
];

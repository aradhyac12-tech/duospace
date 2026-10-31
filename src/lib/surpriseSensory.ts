/**
 * Surprise 3.0 §10: Sensory Director.
 *
 * A SensorySettings object is a PARTIAL override on top of a surprise's own
 * deterministic Haptic DNA (lib/surpriseHapticDNA.ts) — every field is
 * optional, and "Auto" (the required default per the brief) simply means
 * "no override object, or a field left out of it". This module never
 * generates DNA itself; applySensoryOverride() takes DNA the normal
 * deterministic path already produced and overrides only the fields the
 * creator actually pinned, so Auto stays Auto and this can't drift out of
 * sync with the deterministic generator by duplicating its logic.
 */
import type { HapticDNA, HapticRhythm, HapticTexture } from "@/lib/surpriseHapticDNA";

export type SensoryHapticChoice = "auto" | HapticTexture;
export type SensoryRhythmChoice = "auto" | HapticRhythm | "custom";
export type SensoryRhythmSpeed = "slow" | "medium" | "fast";
export type SensoryPartnerReactionMode = "off" | "on_receive" | "on_open" | "on_complete" | "custom";

export interface SensorySettings {
  /** "auto" (default) leaves texture to the deterministic DNA; any other
   *  value pins the surprise's texture regardless of mood/seed. */
  haptic?: SensoryHapticChoice;
  /** 0-100. Undefined = Auto (the DNA's own seeded intensity). */
  intensity?: number;
  rhythm?: SensoryRhythmChoice;
  rhythmSpeed?: SensoryRhythmSpeed;
  /** 0-100 — reused directly as depth-plane amplitude scale (1.0 = the
   *  DEPTH_PLANE defaults in lib/surpriseDepthPlanes.ts); undefined = 100
   *  (full default amplitude). */
  depth3d?: number;
  /** 0-100 — scales how far tilt/pointer parallax actually travels,
   *  independent of depth3d (a surprise can have deep layering with a
   *  gentle tilt response, or the reverse). Undefined = 100. */
  tiltResponse?: number;
  anticipation?: number;
  climax?: number;
  partnerReaction?: SensoryPartnerReactionMode;
}

const RHYTHM_SPEED_TO_ANTICIPATION: Record<SensoryRhythmSpeed, number> = {
  slow: 80, medium: 50, fast: 20, // slower rhythm reads as MORE build-up
};

/**
 * Applies a (possibly partial, possibly undefined) SensorySettings override
 * on top of deterministically-generated DNA. Called from
 * SurpriseExperienceEngine right after buildHapticDNA — the override never
 * replaces DNA generation, only reshapes its output field-by-field.
 */
export const applySensoryOverride = (dna: HapticDNA, settings?: SensorySettings | null): HapticDNA => {
  if (!settings) return dna;
  const next: HapticDNA = { ...dna };

  if (settings.haptic && settings.haptic !== "auto") next.texture = settings.haptic;
  if (typeof settings.intensity === "number") next.intensity = settings.intensity;
  if (settings.rhythm && settings.rhythm !== "auto" && settings.rhythm !== "custom") next.rhythm = settings.rhythm;
  if (settings.rhythmSpeed) next.anticipation = RHYTHM_SPEED_TO_ANTICIPATION[settings.rhythmSpeed];
  // anticipation/climax explicit overrides take priority over the
  // rhythm-speed-derived anticipation above, matching the Director's own
  // field order (Rhythm speed is the coarse control, Anticipation/Climax
  // sliders are the fine one, and the brief lists them after Rhythm).
  if (typeof settings.anticipation === "number") next.anticipation = settings.anticipation;
  if (typeof settings.climax === "number") next.climax = settings.climax;

  return next;
};

/** depth3d/tiltResponse aren't DNA fields (DNA is haptics-only) — this
 *  reads them straight off the raw settings object for the 3D/parallax
 *  layer (SurpriseReveal) to scale DEPTH_PLANE amplitude by. Undefined
 *  settings, or an undefined field within them, both mean "100" (full,
 *  unscaled default) — the same Auto convention as everything else here. */
export const sensory3dScale = (settings?: SensorySettings | null): { depth3d: number; tiltResponse: number } => ({
  depth3d: (settings?.depth3d ?? 100) / 100,
  tiltResponse: (settings?.tiltResponse ?? 100) / 100,
});

/**
 * Surprise 3.0 §2: "Haptic DNA".
 *
 * Builds on the mood analysis in lib/surpriseHaptics.ts (analyzeSurpriseContent)
 * rather than re-scanning content — that scan is the one source of truth for
 * "what does this surprise's own html/css/js feel like". This module adds
 * the deterministic PER-SURPRISE variation layer the brief asks for: same
 * mood should not mean identical feel every time. The surprise's own id is
 * the seed, so the same surprise always renders the same DNA on both
 * devices (Couple Sync needs this — see §7), while two different romantic
 * surprises land on different rhythm/texture combinations.
 */
import type { SurpriseAnalysis, SurpriseMood } from "@/lib/surpriseHaptics";
import type { HapticKind } from "@/lib/haptics";
import type { HapticSequence } from "@/lib/surpriseHaptics";

export type HapticRhythm =
  | "heartbeat" | "breathing" | "wave" | "sparkle" | "pulse"
  | "burst" | "crescendo" | "knock" | "ripple"
  // v3.12 signature rhythms — each one has its own beat SHAPE and its own
  // per-beat textures (see RHYTHM_KINDS), so they can't be mistaken for the
  // nine above or for each other. Mood-based auto-pick (RHYTHM_BY_MOOD) never
  // chooses these; they only appear when a creator/preset asks for them.
  | "purr" | "rain" | "firework" | "waltz" | "flutter" | "tide" | "morse"
  | "typewriter" | "fizz" | "thunder" | "lullaby" | "fuse" | "slots" | "snow"
  | "drumroll" | "shave" | "duet" | "whisper" | "lockbreak" | "gallop" | "sway";

/** Deliberately the same vocabulary as HapticKind's discrete-feel subset —
 *  every texture maps 1:1 onto an existing primitive, so realizing a DNA
 *  never needs a new haptic primitive, only a new arrangement of the ones
 *  lib/haptics.ts already has. */
export type HapticTexture = "soft" | "light" | "medium" | "heavy" | "rigid" | "selection" | "double";

export interface HapticDNA {
  mood: SurpriseMood;
  /** 0-100 — overall felt strength; also read by the Sensory Director's
   *  Intensity slider (§10) as its "Auto" baseline before any manual override. */
  intensity: number;
  rhythm: HapticRhythm;
  texture: HapticTexture;
  /** 0-100 — how much the beat count/spacing builds before a climax. */
  anticipation: number;
  /** 0-100 — how big MAJOR_REVEAL reads relative to everything before it. */
  climax: number;
  /** Texture used for COMPLETE/CLOSE — usually softer than the main texture
   *  so an ending never feels as sharp as the opening did. */
  resolution: HapticTexture;
}

const RHYTHM_BY_MOOD: Record<SurpriseMood, HapticRhythm[]> = {
  romantic: ["heartbeat", "breathing", "wave"],
  celebratory: ["burst", "sparkle", "crescendo"],
  playful: ["sparkle", "knock", "pulse"],
  calm: ["breathing", "wave", "ripple"],
  intense: ["crescendo", "burst", "knock"],
};

const TEXTURE_BY_MOOD: Record<SurpriseMood, HapticTexture[]> = {
  romantic: ["soft", "light", "double"],
  celebratory: ["medium", "heavy", "double"],
  playful: ["light", "selection", "medium"],
  calm: ["soft", "light"],
  intense: ["heavy", "rigid", "medium"],
};

const RESOLUTION_BY_MOOD: Record<SurpriseMood, HapticTexture[]> = {
  romantic: ["soft", "light"],
  celebratory: ["light", "double"],
  playful: ["light", "selection"],
  calm: ["soft"],
  intense: ["medium", "light"],
};

const INTENSITY_BASE: Record<SurpriseMood, number> = {
  romantic: 45, celebratory: 70, playful: 55, calm: 30, intense: 85,
};

/** Small, fast, deterministic string hash — same algorithm as
 *  surpriseEngine.ts's surpriseVariant(), duplicated locally on purpose:
 *  that module imports the Supabase client, which this leaf-level haptics
 *  layer has no business pulling in just to hash a string. */
const hashSeed = (id: string): number => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
};

const jitter = (seed: number, offsetBits: number, base: number, spread: number): number => {
  const span = spread * 2 + 1;
  const v = base + (((seed >>> offsetBits) % span) - spread);
  return Math.max(0, Math.min(100, v));
};

/**
 * Deterministic per-surprise Haptic DNA. Confidence-aware: a low-confidence
 * mood read (see analyzeSurpriseContent) pulls resolution toward the
 * gentlest textures for that mood rather than committing to the seed's full
 * pick — same reasoning buildHapticScore already uses for blending open
 * sequences, applied here to the one field (resolution) where guessing
 * wrong would be most noticeable (it's the LAST thing felt).
 */
export const buildHapticDNA = (surpriseId: string, analysis: SurpriseAnalysis): HapticDNA => {
  const seed = hashSeed(surpriseId);
  const mood = analysis.mood;
  const rhythms = RHYTHM_BY_MOOD[mood];
  const textures = TEXTURE_BY_MOOD[mood];
  const resolutions = RESOLUTION_BY_MOOD[mood];

  const rhythm = rhythms[seed % rhythms.length];
  const texture = textures[Math.floor(seed / 7) % textures.length];
  const resolution = analysis.confidence >= 0.4
    ? resolutions[Math.floor(seed / 13) % resolutions.length]
    : resolutions[0]; // gentlest option for this mood when the read is shaky

  return {
    mood,
    rhythm,
    texture,
    resolution,
    intensity: jitter(seed, 2, INTENSITY_BASE[mood], 15),
    anticipation: jitter(seed, 5, 50, 20),
    climax: jitter(seed, 9, 80, 15),
  };
};

const TEXTURE_TO_KIND: Record<HapticTexture, HapticKind> = {
  soft: "soft", light: "light", medium: "medium", heavy: "heavy",
  rigid: "rigid", selection: "selection", double: "double",
};

// §2 audit finding: dna.intensity was generated (deterministically AND via
// Sensory Director overrides) but never actually read anywhere — realized
// haptics ignored it entirely. Fixed here the same way lib/haptics.ts's own
// global Haptic Intensity setting already nudges native impact styles one
// tier at the extremes (that file's own IMPACT_UP/IMPACT_DOWN) — same idea,
// applied to this DNA's OWN per-surprise texture rather than the device-wide
// preference, so the two stack rather than compete.
const STRENGTH_LADDER: HapticTexture[] = ["soft", "light", "medium", "heavy", "rigid"];

/** "selection"/"double" are textural SHAPES (a tick, a two-beat pattern),
 *  not points on a raw-strength ladder — intensity leaves them alone. */
const scaleTextureByIntensity = (texture: HapticTexture, intensity: number): HapticTexture => {
  const i = STRENGTH_LADDER.indexOf(texture);
  if (i === -1) return texture;
  const shift = intensity >= 75 ? 1 : intensity <= 25 ? -1 : 0;
  return STRENGTH_LADDER[Math.max(0, Math.min(STRENGTH_LADDER.length - 1, i + shift))];
};

/** Relative beat offsets (ms, before intensity/anticipation scaling) per
 *  rhythm concept — the felt SHAPE of each rhythm, not its final timing. */
const RHYTHM_CURVE: Record<HapticRhythm, number[]> = {
  heartbeat: [0, 140],
  breathing: [0, 420],
  wave: [0, 100, 240],
  sparkle: [0, 60, 130, 190],
  pulse: [0, 170, 340],
  burst: [0, 40, 80],
  crescendo: [0, 90, 160, 210],
  knock: [0, 130],
  ripple: [0, 80, 190, 320],
  // ── v3.12 signature rhythms ──
  purr: [0, 45, 90, 135, 180, 225, 270, 315, 360, 405],
  rain: [0, 110, 150, 330, 420, 470, 610, 650, 700, 820],
  firework: [0, 60, 110, 150, 180, 205, 225, 520, 560, 610, 700],
  waltz: [0, 300, 520],
  flutter: [0, 70, 95, 210, 240, 260, 420, 455],
  tide: [0, 220, 460, 760, 1050, 1250],
  morse: [0, 130, 380, 480, 800, 900, 1000, 1200],
  typewriter: [0, 90, 150, 280, 340, 420, 560, 640, 720, 1000],
  fizz: [0, 40, 70, 120, 150, 210, 240, 290, 330, 380, 700],
  thunder: [0, 60, 120, 200, 300, 420, 700, 740],
  lullaby: [0, 500, 780, 1280, 1560],
  fuse: [0, 300, 520, 680, 790, 870, 930, 975, 1010, 1040],
  slots: [0, 30, 60, 90, 120, 150, 180, 210, 240, 500, 800, 1100],
  snow: [0, 500, 1100, 1500, 2200],
  drumroll: [0, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500, 550, 900],
  shave: [0, 250, 375, 625, 875, 1500, 1750],
  duet: [0, 130, 300, 430],
  whisper: [0, 90, 1000],
  lockbreak: [0, 180, 260, 520, 600, 1100],
  gallop: [0, 80, 200, 280, 400, 480],
  sway: [0, 240, 520, 880, 1200],
};

/** "base" = the surprise's own texture (so Haptic/Intensity still apply);
 *  any other value pins that beat to a fixed primitive. Only the v3.12
 *  signature rhythms use pinned beats — the original nine stay all-"base",
 *  exactly as before. */
type BeatKind = "base" | HapticKind;
const RHYTHM_KINDS: Partial<Record<HapticRhythm, BeatKind[]>> = {
  purr: ["soft", "tick", "tick", "soft", "tick", "tick", "soft", "tick", "tick", "soft"],
  rain: ["tick", "tick", "selection", "tick", "tick", "selection", "tick", "tick", "selection", "light"],
  firework: ["tick", "tick", "tick", "tick", "tick", "tick", "tick", "heavy", "rigid", "selection", "tick"],
  waltz: ["base", "soft", "soft"],
  flutter: ["tick", "tick", "soft", "tick", "tick", "soft", "tick", "soft"],
  tide: ["soft", "light", "medium", "heavy", "medium", "soft"],
  morse: ["tick", "heavy", "tick", "tick", "tick", "tick", "tick", "heavy"],
  typewriter: ["light", "tick", "light", "tick", "light", "tick", "tick", "light", "tick", "double"],
  fizz: ["selection", "tick", "selection", "tick", "selection", "selection", "tick", "selection", "tick", "selection", "medium"],
  thunder: ["soft", "soft", "light", "medium", "medium", "heavy", "rigid", "heavy"],
  lullaby: ["soft", "light", "soft", "light", "soft"],
  fuse: ["tick", "tick", "selection", "tick", "tick", "selection", "tick", "tick", "selection", "medium"],
  slots: ["tick", "tick", "tick", "tick", "tick", "tick", "tick", "tick", "tick", "heavy", "heavy", "rigid"],
  snow: ["tick", "selection", "tick", "selection", "tick"],
  drumroll: ["light", "tick", "light", "tick", "light", "tick", "light", "tick", "light", "tick", "light", "tick", "rigid"],
  shave: ["medium", "light", "light", "medium", "medium", "heavy", "heavy"],
  duet: ["soft", "soft", "light", "light"],
  whisper: ["tick", "tick", "soft"],
  lockbreak: ["tick", "tick", "selection", "tick", "selection", "heavy"],
  gallop: ["base", "soft", "base", "soft", "base", "soft"],
  sway: ["soft", "tick", "soft", "tick", "soft"],
};

/** The felt primitive for beat `i` of `rhythm` (falls back to the surprise's
 *  own texture-kind when the rhythm doesn't pin that beat). */
const beatKind = (rhythm: HapticRhythm, i: number, base: HapticKind): HapticKind => {
  const k = RHYTHM_KINDS[rhythm]?.[i];
  return !k || k === "base" ? base : k;
};

export type ExperienceMoment = "receive" | "materialize" | "interact" | "majorReveal" | "complete" | "close";

/**
 * Realizes a Haptic DNA into a concrete HapticSequence for one moment in
 * the surprise's life. This is the seam SurpriseExperienceEngine calls —
 * kept as a pure function (DNA + moment in, sequence out) so it's trivially
 * testable without any of the engine's dispatch/idempotency state.
 */
export const dnaToSequence = (dna: HapticDNA, moment: ExperienceMoment): HapticSequence => {
  const kind = TEXTURE_TO_KIND[scaleTextureByIntensity(dna.texture, dna.intensity)];
  const resolutionKind = TEXTURE_TO_KIND[scaleTextureByIntensity(dna.resolution, dna.intensity)];
  const curve = RHYTHM_CURVE[dna.rhythm];
  // Anticipation stretches (more build-up) or compresses (snappier) the
  // rhythm's own timing; intensity has no separate timing effect here —
  // it's read by callers that pick BETWEEN kinds (see climaxKind below),
  // not one that scales delay.
  const scale = 0.6 + (dna.anticipation / 100) * 0.8;

  switch (moment) {
    case "receive":
      // Quietest possible beat — the person may not even be looking at the
      // screen. One tick, always, regardless of DNA.
      return [{ kind: "tick", delayMs: 0 }];

    case "materialize": {
      // A quick arrival ping: first two curve beats only, compressed hard —
      // this is "message arrived", not the full rhythm.
      return curve.slice(0, 2).map((d, i) => ({
        kind: i === 0 ? beatKind(dna.rhythm, 0, kind) : "tick",
        delayMs: Math.round(d * scale * 0.35),
      }));
    }

    case "interact":
      // The full anticipation arc, at this surprise's own texture.
      return curve.map((d, i) => ({ kind: beatKind(dna.rhythm, i, kind), delayMs: Math.round(d * scale) }));

    case "majorReveal": {
      const climaxKind: HapticKind = dna.climax >= 70 ? "rigid" : dna.climax >= 40 ? "heavy" : "medium";
      const buildup = curve.map((d, i) => ({ kind: beatKind(dna.rhythm, i, kind), delayMs: Math.round(d * scale * 0.5) }));
      const climaxDelay = Math.round((curve[curve.length - 1] ?? 0) * scale * 0.5) + 180;
      return [...buildup, { kind: climaxKind, delayMs: climaxDelay }];
    }

    case "complete":
      // One affirming extra tap after the mood's own close beat, same
      // shape SurpriseHapticEngine.complete used — "that's done", not
      // identical to bailing early.
      return [{ kind: resolutionKind, delayMs: 0 }, { kind: "double", delayMs: 160 }];

    case "close":
      return [{ kind: resolutionKind, delayMs: 0 }];
  }
};

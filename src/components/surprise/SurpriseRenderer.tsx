import { lazy, Suspense } from "react";
import type { SurpriseMood } from "@/lib/surpriseHaptics";

// ─── SurpriseRenderer ────────────────────────────────────────────────────
// Redesign brief §5: replaces the old SurpriseScene3D (one hardcoded
// particle field for every surprise) with a real dispatcher across 5
// mood-distinct scenes. Mood selection itself is NOT done here — it's
// already computed once per surprise by analyzeSurpriseContent in
// lib/surpriseHaptics.ts (the same heuristic scan that already drives the
// haptic sequence and the glow tint), so the visual scene and the haptic
// feel are always reading the same signal rather than picking separately.
// Per the brief: "Preserve the existing surprise mood analysis as a
// fallback. Do not claim the current regex/emoji/CSS/JS analyzer is AI.
// Prefer explicit creator intent when available." — there is no explicit-
// intent field in the schema yet (no migration per the brief's own
// constraint), so today the content analysis IS the only source; the
// `explicitMood` prop below is where a future creator-set mood field would
// plug in without this component's callers needing to change.
//
// Each scene is lazy-loaded individually (not one bundle for all 5) so
// opening a romantic surprise doesn't pull in the confetti/blob code for
// the other 4 moods it'll never render.
const RomanticScene = lazy(() => import("@/components/surprise/scenes/RomanticScene"));
const CelebrationScene = lazy(() => import("@/components/surprise/scenes/CelebrationScene"));
const PlayfulScene = lazy(() => import("@/components/surprise/scenes/PlayfulScene"));
const CalmScene = lazy(() => import("@/components/surprise/scenes/CalmScene"));
const IntenseScene = lazy(() => import("@/components/surprise/scenes/IntenseScene"));

const SCENE_BY_MOOD: Record<SurpriseMood, typeof RomanticScene> = {
  romantic: RomanticScene,
  celebratory: CelebrationScene,
  playful: PlayfulScene,
  calm: CalmScene,
  intense: IntenseScene,
};

interface SurpriseRendererProps {
  /** From analyzeSurpriseContent(surprise) — see lib/surpriseHaptics.ts. */
  mood: SurpriseMood;
  seed: number;
  className?: string;
  /** Adapter seam for a future explicit creator-chosen mood (brief §5's
   *  "future-compatible metadata: mood"). Unused today — no schema field
   *  exists yet — but takes priority over the analyzed mood the instant
   *  one does, without any caller needing to change. */
  explicitMood?: SurpriseMood | null;
  /** Phase 4 (§11): live tilt input (device gyroscope, or pointer-drag
   *  fallback), forwarded straight through to whichever scene mounts. See
   *  useAmbientScene's getTilt param for why this is a getter, not a
   *  value. */
  getTilt?: () => { x: number; y: number };
}

const SurpriseRenderer = ({ mood, seed, className, explicitMood, getTilt }: SurpriseRendererProps) => {
  const Scene = SCENE_BY_MOOD[explicitMood ?? mood];
  return (
    <Suspense fallback={null}>
      <Scene seed={seed} className={className} getTilt={getTilt} />
    </Suspense>
  );
};

export default SurpriseRenderer;

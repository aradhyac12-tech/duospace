import { useHapticOnMount } from "@/hooks/useHapticOnMount";
import type { HapticPatternName } from "@/lib/hapticEngine";

/**
 * Renders nothing; fires a haptic when the surface it lives in is presented
 * (mount) and, optionally, when it is dismissed (unmount). Drop it inside a
 * Radix `*Content` — those only mount while open.
 */
export const HapticOnMount = ({ open, close }: { open: HapticPatternName; close?: HapticPatternName }) => {
  useHapticOnMount(open, close);
  return null;
};

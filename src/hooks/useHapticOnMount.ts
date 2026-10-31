import { useEffect } from "react";
import { fireNamed, type HapticPatternName } from "@/lib/hapticEngine";

/**
 * Fire a haptic when a surface (sheet / drawer / dialog) mounts, and an
 * optional one when it unmounts. Radix mounts `*Content` only while open, so
 * mount == "presented" and unmount == "dismissed".
 *
 * Imports from hapticEngine (not haptics.ts) on purpose — see the note at the
 * top of hapticEngine.ts.
 */
export function useHapticOnMount(open: HapticPatternName, close?: HapticPatternName) {
  useEffect(() => {
    void fireNamed(open);
    return () => {
      if (close) void fireNamed(close);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

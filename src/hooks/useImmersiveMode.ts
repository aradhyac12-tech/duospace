import { useEffect, useSyncExternalStore } from "react";
import { setImmersive, isAnyImmersiveActive, subscribeImmersive } from "@/lib/immersiveMode";

/**
 * Call from a full-screen surface (photo/video viewer, camera, etc.) with a
 * stable id and whether it's currently open. Registers/unregisters
 * automatically, including on unmount, so a surface that closes by
 * unmounting (rather than toggling `active` to false first) can't leave a
 * stale "immersive" flag stuck on.
 */
export function useSetImmersive(id: string, active: boolean) {
  useEffect(() => {
    setImmersive(id, active);
    return () => setImmersive(id, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, active]);
}

/** Used by useDockVisibility — true while any surface above has registered. */
export function useIsImmersive(): boolean {
  return useSyncExternalStore(subscribeImmersive, isAnyImmersiveActive, () => false);
}

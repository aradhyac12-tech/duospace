/**
 * Immersive-mode registry — replaces the old scroll-driven dock hide/show.
 *
 * Per the shell redesign: the dock is now a stable, always-visible part of
 * the app shell. It should only step aside for a genuine full-screen
 * interaction it would otherwise sit on top of — a photo/video viewer, an
 * active call, the camera. None of those live anywhere near FloatingDock in
 * the component tree (FloatingDock is a sibling of the routed page content
 * in AppLayout, not an ancestor), so there's no prop path between "PhotoViewer
 * just opened, deep inside Chat.tsx" and "FloatingDock should hide."
 *
 * This is a deliberately tiny module-scope pub-sub — not a new state
 * management system, the same scale/shape as this project's existing
 * lib/haptics.ts or lib/telemetry.ts singletons. A surface registers itself
 * while mounted/open; the dock (via useIsImmersive, used inside
 * useDockVisibility) just asks "is anything registered right now."
 *
 * Active calls don't need to register here — useDockVisibility reads
 * CallContext directly for that, since AppLayout already sits inside
 * CallProvider and that state is already centrally tracked.
 */

type Listener = () => void;

const activeSurfaces = new Set<string>();
const listeners = new Set<Listener>();

function notify() {
  listeners.forEach((l) => l());
}

/** Call from a full-screen surface's own effect: setImmersive(id, isOpen). */
export function setImmersive(id: string, active: boolean) {
  const had = activeSurfaces.has(id);
  if (active) activeSurfaces.add(id);
  else activeSurfaces.delete(id);
  if (had !== active) notify();
}

export function isAnyImmersiveActive() {
  return activeSurfaces.size > 0;
}

export function subscribeImmersive(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

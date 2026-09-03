import { createContext, useContext, useState, type ReactNode } from "react";

/**
 * BottomSurfaceContext — plumbing for DuoSpaceBottomSurface (Phase 5.5:
 * Unified Bottom Surface + Zero-Flicker Navigation).
 *
 * The unified surface is a single fixed-position glass shell mounted once
 * by AppLayout (see DuoSpaceBottomSurface.tsx), physically containing both
 * the chat composer row and the Chat/Calls nav row as one material. Chat.tsx
 * itself still OWNS the composer (all send/recording/attach/typing state and
 * handlers stay exactly where they were) — it just renders MessageComposer
 * through a React portal into a DOM node this context exposes, so the
 * composer's actual pixels land physically inside the shared shell instead
 * of in Chat's own document flow. This is deliberately a portal, not a
 * lifted-state rewrite: Chat.tsx's ~1800 lines of existing message/call/
 * upload logic are untouched, only WHERE the composer's JSX is mounted
 * changes.
 *
 * `surfaceHeight` is the shell's own live measured height (composer +
 * nav + safe area, whatever state it's currently in), fed back to Chat's
 * message list and Calls' content list as their bottom scroll-inset — see
 * DuoSpaceBottomSurface's ResizeObserver. This replaces the old fixed
 * `--dock-reserve`/pb-24 magic numbers for these two screens with the
 * shell's real, dynamic height (brief section 2: "use measured/dynamic
 * dimensions where necessary rather than magic numbers").
 */

interface BottomSurfaceCtx {
  composerHost: HTMLDivElement | null;
  setComposerHost: (el: HTMLDivElement | null) => void;
  surfaceHeight: number;
  setSurfaceHeight: (h: number) => void;
}

const BottomSurfaceContext = createContext<BottomSurfaceCtx | null>(null);

export const BottomSurfaceProvider = ({ children }: { children: ReactNode }) => {
  const [composerHost, setComposerHost] = useState<HTMLDivElement | null>(null);
  const [surfaceHeight, setSurfaceHeight] = useState(0);

  return (
    <BottomSurfaceContext.Provider value={{ composerHost, setComposerHost, surfaceHeight, setSurfaceHeight }}>
      {children}
    </BottomSurfaceContext.Provider>
  );
};

/** The DOM node MessageComposer should portal into. Null until
 *  DuoSpaceBottomSurface has mounted and registered it — callers must fall
 *  back to an inline render for that brief pre-mount window (see Chat.tsx). */
export function useComposerHost(): HTMLDivElement | null {
  return useContext(BottomSurfaceContext)?.composerHost ?? null;
}

/** Called once by DuoSpaceBottomSurface to register its portal target. */
export function useRegisterComposerHost() {
  const ctx = useContext(BottomSurfaceContext);
  return ctx?.setComposerHost ?? (() => {});
}

/** Live height (px) of the unified bottom surface — use as bottom scroll
 *  padding/inset on Chat's message list and Calls' content list. 0 (and
 *  therefore a no-op) on any page that isn't wrapped by the surface. */
export function useBottomSurfaceHeight(): number {
  return useContext(BottomSurfaceContext)?.surfaceHeight ?? 0;
}

/** Called once by DuoSpaceBottomSurface's ResizeObserver. */
export function useReportSurfaceHeight() {
  const ctx = useContext(BottomSurfaceContext);
  return ctx?.setSurfaceHeight ?? (() => {});
}

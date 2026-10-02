/**
 * React-facing hook for the DuoSpace Error Manager.
 *
 * Gives a component a `capture` function that's pre-tagged with its screen
 * name, plus the manager's live error stream so a top-level listener (e.g.
 * a global toast/card host) can react to any error captured anywhere.
 *
 * Usage:
 *   const { capture } = useErrorManager("Chat");
 *   try { await sendMessage(); }
 *   catch (err) { capture("DS-CHAT-001", { component: "MessageComposer", cause: err }); }
 */
import { useCallback, useEffect, useRef } from "react";
import { errorManager } from "./errorManager";
import type { CaptureOptions, DuoSpaceErrorPayload } from "./types";

export function useErrorManager(screen?: string) {
  const capture = useCallback(
    (code: string, options: CaptureOptions = {}) => errorManager.capture(code, { screen, ...options }),
    [screen],
  );
  return { capture, errorManager };
}

/** Subscribe to every error captured app-wide. Intended for a single top-level host (e.g. in App.tsx). */
export function useErrorStream(onError: (payload: DuoSpaceErrorPayload) => void): void {
  const handlerRef = useRef(onError);
  handlerRef.current = onError;

  useEffect(() => errorManager.subscribe((payload) => handlerRef.current(payload)), []);
}

import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { ErrorBoundary } from "@/components/ErrorBoundary";

// Same chunks App.tsx's routePreload already warms — a second lazy() call
// for the same module path dedupes to the same chunk under Vite, so this
// doesn't create a second bundle.
const Chat = lazy(() => import("@/pages/Chat"));
const Calls = lazy(() => import("@/pages/Calls"));

/**
 * ChatCallsShell — Phase 5.5 section 5: "Do NOT use a conventional route
 * transition (fade out / blank frame / mount / fade in)."
 *
 * The root cause of nearly every flicker in the original brief traced back
 * to ONE thing: AppLayout's <Outlet/> + <AnimatePresence mode="wait">
 * fully unmounted whichever page was active and mounted the other from
 * scratch on every Chat ↔ Calls tap — a real remount (fresh component
 * instances, fresh effects, fresh scroll position, fresh image decode),
 * not just a visual transition. No amount of tuning the fade/slide could
 * fix that; the fix is not routing through unmount at all for these two
 * screens specifically.
 *
 * This component mounts Chat once, and mounts Calls the first time the
 * user actually visits it (avoids loading Calls' Daily.co/CallKit-adjacent
 * bundle before it's ever needed) — and after that first mount, BOTH stay
 * mounted for the rest of the session. Switching tabs only toggles which
 * pane is visible/interactive; nothing unmounts, so scroll position, the
 * composer draft, loaded images, and in-flight realtime subscriptions are
 * preserved automatically (sections 5, 7, 9, 11) because there's no
 * teardown to preserve them THROUGH.
 *
 * AppLayout renders this INSTEAD of <Outlet/> only when the route is
 * /chat or /calls; every other page still goes through the normal
 * Outlet + AnimatePresence route transition, unchanged (this phase is
 * scoped to Chat/Calls only, per the brief's own "don't redesign
 * unrelated screens" instruction).
 */

interface ChatCallsShellProps {
  active: "chat" | "calls";
}

const PANE_OFFSET = 10; // px — brief section 6: "approximately 8-14px"
const PANE_DURATION = 0.22; // s — brief section 6: "approximately 180-260ms"

/** side: which edge this pane conceptually lives on (chat=left, calls=
 *  right, matching nav order) — a pane's hidden-state x is always toward
 *  its own side regardless of switch direction, so leaving-forward and
 *  entering-backward both move the SAME way for a given pane, and no
 *  runtime "which direction did we just switch" bookkeeping is needed. */
const Pane = ({ active, side, children }: { active: boolean; side: "left" | "right"; children: ReactNode }) => {
  const hiddenX = side === "left" ? -PANE_OFFSET : PANE_OFFSET;
  return (
    <motion.div
      className="absolute inset-0 flex flex-col"
      initial={false}
      animate={{ opacity: active ? 1 : 0, x: active ? 0 : hiddenX }}
      transition={{ duration: PANE_DURATION, ease: [0.32, 0.72, 0, 1] }}
      style={{ pointerEvents: active ? "auto" : "none" }}
      aria-hidden={!active}
      // `inert` (not just aria-hidden) so a focused control in the hidden
      // pane can't be reached by keyboard/AT while it's visually gone —
      // same reasoning FloatingDock's tabIndex={-1} comment gives for the
      // nav buttons.
      {...(!active ? ({ inert: "" } as Record<string, string>) : {})}
    >
      {children}
    </motion.div>
  );
};

const ChatCallsShell = ({ active }: ChatCallsShellProps) => {
  const [visitedCalls, setVisitedCalls] = useState(active === "calls");

  useEffect(() => {
    if (active === "calls") setVisitedCalls(true);
  }, [active]);

  return (
    <div className="relative flex-1 min-h-0">
      <Pane active={active === "chat"} side="left">
        <ErrorBoundary context="Chat">
          <Suspense fallback={<PageSkeleton variant="chat" />}>
            <Chat />
          </Suspense>
        </ErrorBoundary>
      </Pane>

      {/* Calls only mounts once actually visited — kept mounted forever
          after that (never conditionally unmounted again), so the second
          and every later visit is instant/flicker-free, matching Chat. */}
      {visitedCalls && (
        <Pane active={active === "calls"} side="right">
          <ErrorBoundary context="Calls">
            <Suspense fallback={<PageSkeleton variant="list" />}>
              <Calls />
            </Suspense>
          </ErrorBoundary>
        </Pane>
      )}
    </div>
  );
};

export default ChatCallsShell;

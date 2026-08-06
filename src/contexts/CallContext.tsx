import { createContext, useContext, ReactNode } from "react";
import { useDailyCall } from "@/hooks/useDailyCall";

/**
 * BUG FIX ("Duplicate DailyIframe instances are not allowed"):
 *
 * Chat.tsx and Calls.tsx each used to call `useDailyCall()` independently —
 * two entirely separate hook instances, each with its own `callRef` and
 * its own `joinInProgressRef` re-entrancy lock. That lock only ever
 * protected against a double-tap *within one page*; it had no way to know
 * about a call object created by the *other* page's instance. Daily's SDK
 * only allows a single `DailyCall` object to exist anywhere on the page at
 * once, so any sequence that left one page's call object alive while the
 * other page tried to create its own (e.g. a call still active on Chat's
 * instance while quickly navigating to Calls and starting a new one before
 * the old instance's teardown had fully settled) threw exactly this error.
 *
 * The fix is to only ever create the hook once, here, and have every
 * consumer share the same instance via context — so there's exactly one
 * `callRef` and one re-entrancy lock for the whole app, and (as a bonus)
 * an active call now survives navigating between Chat and Calls instead of
 * being torn down by whichever page's instance happens to unmount.
 */
type CallContextValue = ReturnType<typeof useDailyCall>;

const CallContext = createContext<CallContextValue | null>(null);

export const CallProvider = ({ children }: { children: ReactNode }) => {
  const call = useDailyCall();
  return <CallContext.Provider value={call}>{children}</CallContext.Provider>;
};

export const useCall = (): CallContextValue => {
  const ctx = useContext(CallContext);
  if (!ctx) {
    throw new Error("useCall() must be used within a <CallProvider> — it's mounted once in App.tsx around the protected app routes.");
  }
  return ctx;
};

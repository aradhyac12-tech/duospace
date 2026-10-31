/**
 * useCallEngine — returns the app's single CallEngine (self-hosted LiveKit).
 * CallContext.tsx is the only consumer; screens reach the engine via
 * useCall(). Kept as a seam so CallContext never imports the adapter's
 * internals directly.
 */
import { useSelfHostedCallEngineAdapter } from "./SelfHostedCallEngineAdapter";
import type { CallEngine, CallEngineProviderId } from "./types";

export const useCallEngine = (): CallEngine & { activeProvider: CallEngineProviderId } => {
  const engine = useSelfHostedCallEngineAdapter();
  return { ...engine, activeProvider: "self_hosted" };
};

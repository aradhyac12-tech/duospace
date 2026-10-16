/**
 * callWarmup — keeps the call backend "hot" so picking up is instant.
 *
 * ROOT CAUSE of the 4–5 s dead air after answering: the `livekit-token` edge
 * function was only warmed ONCE, in idle time right after login. Edge isolates
 * go cold after a few idle minutes, so the first token request of a real call
 * (made right after the person taps Accept / Call) paid the full cold start
 * (seconds) in front of the LiveKit connect. This re-warms it on a timer,
 * when the app returns to the foreground, and the moment a call starts ringing.
 *
 * The warm-up request is an empty body: it authenticates, then fails 400
 * ("callId is required") — it mints no token and touches no call.
 */
import { invokeEdgeFunction } from "@/lib/edgeFunction";
import { loadLiveKitSdk } from "@/lib/callEngine/SelfHostedCallEngineAdapter";

const MIN_GAP_MS = 20_000;
const KEEP_WARM_EVERY_MS = 3 * 60_000;
let lastWarmAt = 0;

export function warmCallBackend(force = false): void {
  const now = Date.now();
  if (!force && now - lastWarmAt < MIN_GAP_MS) return;
  lastWarmAt = now;
  void loadLiveKitSdk().catch(() => {});
  invokeEdgeFunction("livekit-token", { body: {}, timeoutMs: 25_000, quiet: true, retry: false }).catch(() => {});
}

/** Start the keep-warm loop; returns a disposer. */
export function startCallKeepWarm(): () => void {
  if (typeof document === "undefined") return () => {};
  const tick = () => { if (document.visibilityState === "visible") warmCallBackend(); };
  const onVisible = () => { if (document.visibilityState === "visible") warmCallBackend(); };
  const id = setInterval(tick, KEEP_WARM_EVERY_MS);
  document.addEventListener("visibilitychange", onVisible);
  return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVisible); };
}

/**
 * musicWarmup — keeps the SoundCloud backend "hot" so the first tap after idle starts fast.
 *
 * ROOT CAUSE of the slow first play: the soundcloud-search edge isolate goes cold after a few idle
 * minutes, and a cold isolate must also re-scrape SoundCloud's client_id (fetch the web player
 * HTML + JS bundle) before it can resolve ANY stream. That cost landed in front of the user's tap.
 * callWarmup.ts already did this for livekit-token; nothing did it for soundcloud-search.
 *
 * The request is deliberately an EMPTY batch (`streams` with no ids): the function starts the
 * client_id lookup and authenticates before it validates the body, so isolate boot + client_id are
 * paid now, then it answers 400 "Invalid trackIds" and resolves nothing. No server change/deploy
 * needed. `quiet` keeps that expected 400 out of the logs and error reporting.
 */
import { invokeEdgeFunction } from "@/lib/edgeFunction";

const MIN_GAP_MS = 45_000;
const KEEP_WARM_EVERY_MS = 3 * 60_000;
let lastWarmAt = 0;

export function warmMusicBackend(force = false): void {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  const now = Date.now();
  if (!force && now - lastWarmAt < MIN_GAP_MS) return;
  lastWarmAt = now;
  invokeEdgeFunction("soundcloud-search", {
    body: { mode: "streams", trackIds: [] }, timeoutMs: 20_000, retry: false, quiet: true,
  }).catch(() => {});
}

/** Warm now, then on a timer and whenever the app returns to the foreground. Returns a disposer. */
export function startMusicKeepWarm(): () => void {
  if (typeof document === "undefined") return () => {};
  warmMusicBackend(true);
  const onVisible = () => { if (document.visibilityState === "visible") warmMusicBackend(); };
  const id = setInterval(onVisible, KEEP_WARM_EVERY_MS);
  document.addEventListener("visibilitychange", onVisible);
  return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVisible); };
}

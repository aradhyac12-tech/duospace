/**
 * fetchSignalingTicket — obtains the short-lived ticket
 * WebSocketSignalingEngine's URL needs, from the `signaling-ticket` edge
 * function (remediation P1-7 — see that function's and auth.ts's own doc
 * comments for why this exists instead of passing the real Supabase
 * session token in the WS URL).
 *
 * PHASE 4: called by callSignalingBridge.ts's transport factory before
 * EVERY WebSocket connection attempt (initial connect and each reconnect),
 * because a ticket is short-lived (~120 s) and a reconnect must never reuse
 * an expired one. Only ever invoked for the self-hosted provider with
 * VITE_SIGNALING_URL set; the call engine never reaches it.
 *
 * NOT RUNTIME-VERIFIED against a live `signaling-ticket` function.
 */
import { setRuntimeSignalingUrl } from "./signalingConfig";
import { invokeEdgeFunction } from "@/lib/edgeFunction";

interface SignalingTicketResponse {
  ticket: string;
  expiresInSeconds: number;
}

export async function fetchSignalingTicket(): Promise<string> {
  const result = await invokeEdgeFunction<SignalingTicketResponse & { signalingUrl?: string | null }>("signaling-ticket", { timeoutMs: 10_000 });
  setRuntimeSignalingUrl(result.signalingUrl);
  return result.ticket;
}

/** Runtime config only (no ticket) — used when the build has no VITE_SIGNALING_URL. */
export async function fetchSignalingConfig(): Promise<{ signalingUrl?: string | null }> {
  return invokeEdgeFunction<{ signalingUrl?: string | null }>("signaling-ticket", { body: { configOnly: true }, timeoutMs: 8_000 });
}

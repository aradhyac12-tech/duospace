/**
 * useCallSignalingBridge — the React face of CallSignalingClient: ONE
 * gateway client per authenticated user, exposed as a stable object so
 * CallContext / IncomingCallOverlay / Calls / Chat can drive the
 * self-hosted call-control lifecycle over the dedicated WebSocket layer.
 *
 * PHASE 4 — this replaces the previous "best-effort parallel
 * acceleration" bridge. The semantics that changed, and why they matter:
 *
 *  - It is no longer optional or silent. Every critical operation
 *    (offer / accept / reject / cancel / end) returns a typed
 *    SignalingResult (see types.ts); "not connected" is a reported
 *    FAILED/QUEUED/TIMEOUT, never a swallowed no-op.
 *  - ensureReady() is the gate for starting a self-hosted call: ready =
 *    authenticated + registered by the gateway. If it fails the call
 *    fails — there is NO implicit fallback to Supabase Realtime, and
 *    the call engine is a separate provider decision that is never made implicitly.
 *  - The socket is kept up (prewarm) for users on the self-hosted
 *    provider, because a callee can only be rung over a connection that
 *    already exists. It reconnects with a fresh ticket each attempt.
 *
 * DAILY IS UNAFFECTED: with the default provider (or VITE_SIGNALING_URL
 * unset) `isConfigured()` is false / nothing here is ever called — no
 * transport is created, no ticket is fetched, no socket is opened. The
 * hook itself performs no network work on mount.
 *
 * Supabase remains the persistent truth. Callers perform the
 * authoritative call_history transition (claim_call / decline_call /
 * cancel_call / the end update) and then signal through this bridge; the
 * bridge never writes the database.
 *
 * NOT RUNTIME-VERIFIED against a live gateway. The client logic is
 * exercised against the real gateway code in-process
 * (src/test/signalingArchitecture.test.ts, callSignalingClient.test.ts).
 */
import { mark as markCallLatency } from "@/lib/callLatency";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { logInfo } from "@/lib/telemetry";
import { CallSignalingClient, type CallSession, type SendOptions } from "./CallSignalingClient";
import { resolveSignalingUrl, loadRuntimeSignalingUrl } from "./signalingConfig";
import { fetchSignalingConfig } from "./signalingTicket";
import { fetchSignalingTicket } from "./signalingTicket";
import { WebSocketSignalingEngine } from "./WebSocketSignalingEngine";
import type {
  ReadyResult, SignalingConnectionState, SignalingMessage, SignalingResult,
} from "./types";

export interface CallSignalingBridge {
  /** True only when a gateway URL was configured at build time. */
  isConfigured: () => boolean;
  /** "Self-hosted call ready": authenticated + registered. Never throws. */
  ensureReady: (opts?: { timeoutMs?: number }) => Promise<ReadyResult>;
  /** Background connect (no permissions, no media, no call records). */
  prewarm: () => void;
  isReady: () => boolean;
  getConnectionState: () => SignalingConnectionState;

  offer: (p: { callId: string; sessionId: string; peerId: string; callType: "voice" | "video" }) => Promise<SignalingResult>;
  ringing: (callId: string) => Promise<SignalingResult>;
  accept: (callId: string, opts?: SendOptions) => Promise<SignalingResult>;
  reject: (callId: string, reason?: "user" | "timeout", opts?: SendOptions) => Promise<SignalingResult>;
  cancel: (callId: string, opts?: SendOptions) => Promise<SignalingResult>;
  end: (callId: string, opts?: SendOptions) => Promise<SignalingResult>;
  /** Hang up / abandon in whatever state the call is in. */
  terminate: (callId: string, hint: { connected: boolean }, opts?: SendOptions) => Promise<SignalingResult>;

  /** Teach the client about a call it learned of WITHOUT a socket offer
   *  (push / Realtime recovery / cold-start poll) so accept/reject still
   *  go over the socket. */
  registerIncoming: (s: { callId: string; sessionId: string; peerId: string; callType?: "voice" | "video" }) => void;
  /** App restarted mid-call: re-attach + resync. */
  registerRecovered: (s: { callId: string; sessionId: string; peerId: string; role: "caller" | "receiver"; state: "RINGING" | "ACCEPTED" }) => void;
  getSession: (callId: string) => CallSession | undefined;

  /** Validated, de-duplicated, session-checked inbound call events. */
  onMessage: (handler: (message: SignalingMessage) => void) => () => void;
  onConnectionState: (handler: (s: SignalingConnectionState) => void) => () => void;
  disconnect: () => void;
}

const NOT_CONFIGURED: SignalingResult = { status: "FAILED", msgId: "", reason: "NOT_CONFIGURED", attempts: 0 };

export function useCallSignalingBridge(userId: string | null | undefined): CallSignalingBridge {
  const clientRef = useRef<CallSignalingClient | null>(null);
  const clientUserRef = useRef<string | null | undefined>(undefined);
  // Listeners live at the bridge level and are re-attached to whichever
  // client instance is current, so a StrictMode remount, a user switch or
  // a manual disconnect never silently orphans a subscriber.
  const messageHandlers = useRef(new Set<(m: SignalingMessage) => void>());
  const clientConfiguredRef = useRef(false);
  // Fetch the runtime signaling URL as soon as someone is signed in, so an
  // incoming call's Accept never waits for it.
  useEffect(() => { if (userId && !resolveSignalingUrl()) void loadRuntimeSignalingUrl(fetchSignalingConfig); }, [userId]);
  const stateHandlers = useRef(new Set<(s: SignalingConnectionState) => void>());

  const getClient = useCallback((): CallSignalingClient => {
    const signalingUrl = resolveSignalingUrl();
    // Reuse unless the URL arrived at runtime after an unconfigured client was built.
    if (clientRef.current && clientUserRef.current === userId && (clientConfiguredRef.current || !signalingUrl)) return clientRef.current;
    clientRef.current?.dispose();
    clientConfiguredRef.current = !!signalingUrl;
    const client = new CallSignalingClient({
      userId,
      configured: !!signalingUrl,
      createTransport: () => new WebSocketSignalingEngine({
        userId: userId as string,
        // A FRESH ticket for every connection attempt (tickets live 120s).
        getUrl: async () => {
          const ticket = await fetchSignalingTicket(); // also refreshes the runtime URL
          return `${resolveSignalingUrl() ?? signalingUrl}?token=${encodeURIComponent(ticket)}`;
        },
      }),
      onTelemetry: (event, data) => { logInfo("call.signaling", event, data); },
    });
    client.onMessage((m) => { for (const h of Array.from(messageHandlers.current)) h(m); });
    client.onConnectionState((s) => { for (const h of Array.from(stateHandlers.current)) h(s); });
    clientRef.current = client;
    clientUserRef.current = userId;
    return client;
  }, [userId]);

  // Lifecycle: dispose on user change/unmount; wake the socket when the
  // app resumes or the network returns instead of waiting out a backoff.
  useEffect(() => {
    const wake = () => { if (typeof document === "undefined" || document.visibilityState !== "hidden") clientRef.current?.nudge(); };
    // Network handover (Wi-Fi ↔ mobile data on Android, back online): the
    // old socket may be half-open — probe it and reconnect with a fresh ticket.
    const netChanged = () => clientRef.current?.onNetworkChange();
    const conn = (navigator as Navigator & { connection?: EventTarget }).connection;
    window.addEventListener("online", netChanged);
    conn?.addEventListener?.("change", netChanged);
    document.addEventListener("visibilitychange", wake);
    return () => {
      window.removeEventListener("online", netChanged);
      conn?.removeEventListener?.("change", netChanged);
      document.removeEventListener("visibilitychange", wake);
      clientRef.current?.dispose();
      clientRef.current = null;
      clientUserRef.current = undefined;
    };
  }, [userId]);

  const isConfigured = useCallback(() => !!resolveSignalingUrl(), []);
  const ensureReady = useCallback(async (opts?: { timeoutMs?: number }) => {
    markCallLatency("signaling_connect_started");
    if (!resolveSignalingUrl() && userId) await loadRuntimeSignalingUrl(fetchSignalingConfig);
    const r = await getClient().ensureReady(opts);
    if (r.ready) markCallLatency("signaling_connected");
    return r;
  }, [getClient]);
  const prewarm = useCallback(() => { if (resolveSignalingUrl() && userId) getClient().prewarm(); }, [getClient, userId]);
  const isReady = useCallback(() => clientRef.current?.isReady() ?? false, []);
  const getConnectionState = useCallback((): SignalingConnectionState => clientRef.current?.getConnectionState() ?? "disconnected", []);

  const guard = useCallback(<A extends unknown[]>(fn: (c: CallSignalingClient, ...a: A) => Promise<SignalingResult>) =>
    (...a: A): Promise<SignalingResult> => (resolveSignalingUrl() && userId ? fn(getClient(), ...a) : Promise.resolve(NOT_CONFIGURED)), [getClient, userId]);

  const offer = useMemo(() => guard(async (c, p: Parameters<CallSignalingBridge["offer"]>[0]) => {
    markCallLatency("offer_sent");
    const r = await c.offer(p);
    if (r.status === "DELIVERED") markCallLatency("offer_delivered");
    return r;
  }), [guard]);
  const ringing = useMemo(() => guard((c, id: string) => c.ringing(id)), [guard]);
  const accept = useMemo(() => guard((c, id: string, o?: SendOptions) => c.accept(id, o)), [guard]);
  const reject = useMemo(() => guard((c, id: string, r?: "user" | "timeout", o?: SendOptions) => c.reject(id, r, o)), [guard]);
  const cancel = useMemo(() => guard((c, id: string, o?: SendOptions) => c.cancel(id, o)), [guard]);
  const end = useMemo(() => guard((c, id: string, o?: SendOptions) => c.end(id, o)), [guard]);
  const terminate = useMemo(() => guard((c, id: string, h: { connected: boolean }, o?: SendOptions) => c.terminate(id, h, o)), [guard]);

  const registerIncoming = useCallback((s: Parameters<CallSignalingBridge["registerIncoming"]>[0]) => {
    if (resolveSignalingUrl() && userId) getClient().registerIncoming(s);
  }, [getClient, userId]);
  const registerRecovered = useCallback((s: Parameters<CallSignalingBridge["registerRecovered"]>[0]) => {
    if (resolveSignalingUrl() && userId) getClient().registerRecovered(s);
  }, [getClient, userId]);
  const getSession = useCallback((id: string) => clientRef.current?.getSession(id), []);

  const onMessage = useCallback((handler: (m: SignalingMessage) => void) => {
    messageHandlers.current.add(handler);
    return () => { messageHandlers.current.delete(handler); };
  }, []);
  const onConnectionState = useCallback((handler: (s: SignalingConnectionState) => void) => {
    stateHandlers.current.add(handler);
    return () => { stateHandlers.current.delete(handler); };
  }, []);
  const disconnect = useCallback(() => {
    clientRef.current?.dispose();
    clientRef.current = null;
    clientUserRef.current = undefined;
  }, []);

  return useMemo(
    () => ({
      isConfigured, ensureReady, prewarm, isReady, getConnectionState,
      offer, ringing, accept, reject, cancel, end, terminate,
      registerIncoming, registerRecovered, getSession, onMessage, onConnectionState, disconnect,
    }),
    [isConfigured, ensureReady, prewarm, isReady, getConnectionState, offer, ringing, accept, reject, cancel, end, terminate,
      registerIncoming, registerRecovered, getSession, onMessage, onConnectionState, disconnect],
  );
}

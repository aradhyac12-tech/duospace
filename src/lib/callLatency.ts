/**
 * callLatency — call-lifecycle timing instrumentation.
 *
 * GAP THIS FILLS (calling reliability pass, item 3 — "instrument the
 * complete call lifecycle"): before this file, nothing recorded WHEN each
 * stage of a call's setup actually happened, so a "calls feel slow" report
 * had no data to point at a specific stage (room creation vs. token fetch
 * vs. WebRTC join vs. first media). This is a plain, dependency-free
 * timing tracker — it never blocks, retries, or affects call behavior; a
 * bug in here must never be able to break a call.
 *
 * SCOPE (read before assuming a stage is missing): DuoSpace's calling
 * architecture is JS-first end to end — even the native
 * Telecom/CallKit integrations only ever draw OS call UI and forward an
 * accept/decline/end action back into this same JS layer (see
 * native/android/CallBridge.kt, native/ios/CallKitManager.swift); there is
 * no native-side WebRTC or the call engine client. So every stage the brief asked
 * for that happens in JS is covered here. Two are NOT, and are out of
 * scope for this file specifically because there is no JS moment that
 * corresponds to them:
 *   - push_dispatched / push_received / native_ringing_started: these
 *     happen entirely inside the native FCM/PushKit layer, before the
 *     WebView (and this module) is even guaranteed to be alive — see
 *     CallNotificationService.kt / PushKitManager.swift. Timing them would
 *     need a native-side clock and a bridge to hand that timestamp to JS
 *     once it wakes up (and NTP-quality clock sync between the phone and
 *     whatever aggregates these logs) — real work, not a gap in this file.
 *   - ICE-level sub-stages (ice_connecting / ice_connected) from the
 *     brief's list: the call engine's public JS SDK does not expose ICE gathering/
 *     connection transitions as first-class events the way raw WebRTTC's
 *     RTCPeerConnection does — only join()/joined-meeting and the
 *     network-quality-change / network-connection events used elsewhere in
 *     The call engine adapter. Not invented here per that file's own "do not
 *     invent unsupported the call engine APIs" rule.
 *
 * Everything else — call_button_tapped through connected, plus
 * claim/token/room sub-stages — is recorded from the real call sites in
 * CallContext.tsx, Calls.tsx, Chat.tsx, and the call engine adapter.
 *
 * DESIGN: DuoSpace is 1:1 calling with one call in flight at a time (see
 * DuoSpaceConnectionService.kt's own "single slot, not a list" comment on
 * the Android side) — so rather than thread an explicit trace id through
 * every call site (CallContext, Calls.tsx/Chat.tsx, and the call engine adapter,
 * which has no notion of call ids at all today), this tracks ONE current
 * trace at a time, the same "single global correlation id" shape
 * src/lib/telemetry.ts already uses for SESSION_ID. beginTrace() starts a
 * fresh one (discarding any unfinished previous trace — a call that never
 * reached "connected" before a new one started has nothing useful left to
 * report anyway), mark() timestamps a named stage against it, and finish()
 * computes the derived latencies and logs them once via telemetry.ts,
 * exactly the way the brief's section 3 asks for them to be reported.
 */
import { logInfo } from "@/lib/telemetry";

/** Every stage the brief asked for that has a real corresponding moment in
 *  this JS-only calling architecture — see the file doc comment above for
 *  what's deliberately excluded and why.
 *
 *  PHASE 1 CALLING-ARCHITECTURE MIGRATION: the four stages below
 *  (provider_selected / engine_initialized / ice_connected /
 *  sfu_connected) are ADDITIVE — the call engine's adapter never marks them (same
 *  reasoning as the file doc comment's "ICE-level sub-stages" exclusion:
 *  The call engine's JS SDK doesn't expose them), so existing the call engine traces are
 *  unaffected. SelfHostedCallEngineAdapter marks provider_selected and
 *  engine_initialized always, and ice_connected/sfu_connected when
 *  LiveKit's client actually exposes that transition — see that
 *  adapter's own NOT RUNTIME-VERIFIED note. This is what lets a future
 *  comparison between providers (STEP 10/11) use the same trace shape
 *  for both, with provider-specific gaps simply left as `null` rather
 *  than estimated. */
export type CallLatencyStage =
  | "call_button_tapped"
  | "call_session_created" // call_history row insert resolved (outgoing) / accept dispatched (incoming)
  | "provider_selected" // CallEngine resolved which adapter is active for this attempt
  | "token_requested"
  | "token_ready"
  | "claim_started" // incoming (accept) only
  | "claim_completed" // incoming (accept) only
  | "engine_initialized" // adapter's underlying client object constructed, pre-join
  | "join_started" // call.join() invoked
  | "ice_connected" // self-hosted only — LiveKit RoomEvent.ConnectionStateChanged reaching "connected"
  | "sfu_connected" // self-hosted only — media connection to the SFU established
  | "joined_meeting" // the call engine "joined-meeting" event / LiveKit room.connect() resolved
  | "remote_participant_detected" // the call engine "participant-joined" / LiveKit ParticipantConnected / already-present-on-join
  | "first_remote_audio"
  | "first_remote_video"
  | "connected" // this device's own UI considers the call live
  // ---- PHASE 4 (authoritative signaling) stages — ADDITIVE ----------------
  // Naming map to the brief's stage list: call_button_pressed ==
  // call_button_tapped (kept, existing tests/logs use it); token_received ==
  // token_ready's twin (both are marked); accept_pressed == the incoming
  // trace's call_button_tapped instant (aliased in beginTrace).
  | "signaling_ready" // outgoing self-hosted: gateway socket authenticated + registered
  | "invite_sent" // outgoing self-hosted: CALL_OFFER acked by the gateway (DELIVERED/RECIPIENT_OFFLINE)
  | "invite_received" // incoming: ring event arrived (pre-trace; see stashIncomingStage)
  | "ringing_displayed" // incoming: ring UI shown (pre-trace)
  | "accept_pressed" // incoming: Accept tapped
  | "accept_sent" // incoming self-hosted: CALL_ACCEPTED acked by the gateway
  | "token_received" // livekit-token response arrived
  | "livekit_connect_started"
  | "livekit_connected" // LiveKit room.connect() resolved
  | "remote_track_received" // first remote audio track subscribed
  | "remote_audio_attached" // that track attached to an audio element
  | "remote_audio_playing" // that element actually reported "playing"
  | "microphone_published" // local mic track published into the LiveKit room
  | "media_degraded" // joined + (maybe) remote track, but no playing audio within the bound
  // ---- self-hosted-only migration: explicit lifecycle stages ------------
  | "participant_joined" // the remote partner's LiveKit participant is in the room
  | "remote_audio_ready" // remote audio verified playing (waitForRemoteAudioReady resolved true)
  | "call_connected" // the call is live for this device (set by finishTrace("connected"))
  // ---- device-verification instrumentation (required stage names) ------
  | "call_started" // trace began (Call tapped / Accept tapped)
  | "signaling_connect_started" | "signaling_connected"
  | "offer_sent" | "offer_delivered"
  | "incoming_call" // incoming offer surfaced on this device
  | "accept_delivered" // gateway confirmed the partner received CALL_ACCEPTED
  | "remote_participant_connected" // alias of remote_participant_detected
  | "remote_audio_track_received" // alias of remote_track_received (audio-only site)
  | "call_failed" // finishTrace("failed", …, reason)
  | "call_ended";

interface Trace {
  traceId: string;
  direction: "outgoing" | "incoming";
  callType: "video" | "voice" | null;
  /** Which CallEngine adapter is handling this attempt — added for the
   *  Phase 1 calling-architecture migration so the call engine vs self-hosted
   *  traces can eventually be compared under identical conditions (STEP
   *  11). Optional and defaults to "daily" via beginTrace's default
   *  param — every existing call site that doesn't pass a provider
   *  keeps producing identical trace output to before this field
   *  existed. */
  provider: "self_hosted";
  marks: Partial<Record<CallLatencyStage, number>>;
  finished: boolean;
  /** Correlates app logs with signaling-server / livekit-token / LiveKit logs. */
  callId?: string;
  sessionId?: string;
  failureReason?: string;
}

/** Aliases so the required stage names exist without renaming existing
 *  (dashboard-visible) stages. */
const STAGE_ALIASES: Partial<Record<CallLatencyStage, CallLatencyStage>> = {
  remote_participant_detected: "remote_participant_connected",
  participant_joined: "remote_participant_connected",
  remote_track_received: "remote_audio_track_received",
};

/** Attach the call's ids to the current trace (safe to call repeatedly). */
export function setTraceIds(ids: { callId?: string | null; sessionId?: string | null }): void {
  if (!current || current.finished) return;
  if (ids.callId) current.callId = ids.callId;
  if (ids.sessionId) current.sessionId = ids.sessionId;
}

let current: Trace | null = null;

/** Stages that happen BEFORE an incoming call's trace exists (the ring
 *  arrives and is shown long before Accept is tapped). Stashed by callId
 *  and merged into the trace when Accept begins it; they then show up as
 *  NEGATIVE offsets from accept_pressed — "this many ms before accept".
 *  Bounded: only the most recent few calls are kept. */
const preTraceMarks = new Map<string, Partial<Record<CallLatencyStage, number>>>();
export function stashIncomingStage(callId: string, stage: CallLatencyStage): void {
  const entry = preTraceMarks.get(callId) ?? {};
  if (entry[stage] === undefined) entry[stage] = now();
  preTraceMarks.delete(callId);
  preTraceMarks.set(callId, entry);
  while (preTraceMarks.size > 5) preTraceMarks.delete(preTraceMarks.keys().next().value as string);
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Start timing a new call attempt. Call this at the earliest real moment
 *  a call begins — the tap on Call, or the moment an incoming call's
 *  Accept is tapped — before any network work starts. */
export function beginTrace(
  direction: "outgoing" | "incoming",
  callType: "video" | "voice" | null,
  provider: "self_hosted" = "self_hosted",
  /** Incoming only: merge ring-time stages stashed for this call. */
  callId?: string,
): string {
  const traceId = `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  current = { traceId, direction, callType, provider, marks: {}, finished: false, callId };
  current.marks.call_button_tapped = now();
  current.marks.call_started = current.marks.call_button_tapped;
  if (direction === "incoming") {
    current.marks.accept_pressed = current.marks.call_button_tapped;
    const stashed = callId ? preTraceMarks.get(callId) : undefined;
    if (stashed) Object.assign(current.marks, stashed);
    if (callId) preTraceMarks.delete(callId);
  }
  return traceId;
}

/** Record a stage timestamp against the current trace. `traceId` is
 *  optional and only used as a staleness guard — if a newer trace has
 *  since started (this call attempt was superseded), the mark is silently
 *  dropped rather than corrupting the new trace's timeline. Safe to call
 *  with no active trace at all (e.g. The call engine adapter's event handlers can
 *  fire outside of any traced attempt, such as a reconnect) — a no-op. */
export function mark(stage: CallLatencyStage, traceId?: string): void {
  if (!current || current.finished) return;
  if (traceId && traceId !== current.traceId) return;
  // First occurrence wins — a stage can legitimately fire more than once
  // (e.g. "remote_participant_detected" on a reconnect), and only the
  // FIRST one is meaningful for setup latency.
  if (current.marks[stage] === undefined) {
    current.marks[stage] = now();
  }
  const alias = STAGE_ALIASES[stage];
  if (alias && current.marks[alias] === undefined) current.marks[alias] = current.marks[stage];
}

export function currentTraceId(): string | null {
  return current?.traceId ?? null;
}

function ms(from?: number, to?: number): number | null {
  if (from === undefined || to === undefined) return null;
  return Math.round(to - from);
}

/** `provider=… stage.<name>=<ms> … <derived>=<ms>` — only values that were
 *  actually measured (null/undefined are omitted, never zero-filled). */
export function latencySummaryLine(provider: string, metrics: Record<string, unknown>): string {
  const parts: string[] = [`provider=${provider}`];
  const stages = (metrics.stagesMs ?? {}) as Record<string, number | null>;
  for (const [k, v] of Object.entries(stages)) if (typeof v === "number") parts.push(`stage.${k}=${v}`);
  for (const [k, v] of Object.entries(metrics)) {
    if (k === "stagesMs" || typeof v !== "number") continue;
    parts.push(`${k}=${v}`);
  }
  return parts.join(" ");
}

/** Finalize the current trace and log the derived latencies. Call once
 *  the call is genuinely connected (or has definitively failed — pass
 *  `outcome: "failed"` so a partial timeline is still logged instead of
 *  silently dropped). Safe to call with no active trace, or to call
 *  more than once (only the first call does anything). */
export function finishTrace(outcome: "connected" | "failed" | "cancelled", traceId?: string, reason?: string): void {
  if (!current || current.finished) return;
  if (traceId && traceId !== current.traceId) return;
  current.finished = true;
  const t = current;
  if (outcome === "failed") {
    t.marks.call_failed = now();
    // Machine-readable code only (e.g. a CallErrorCode / RejectReason) — never free text.
    t.failureReason = reason && /^[A-Za-z0-9_:.-]{1,64}$/.test(reason) ? reason : "UNSPECIFIED";
  }
  if (outcome === "connected" && t.marks.connected === undefined) {
    t.marks.connected = now();
  }
  if (outcome === "connected" && t.marks.call_connected === undefined) {
    t.marks.call_connected = t.marks.connected;
  }
  const tapped = t.marks.call_button_tapped;
  const accepted = t.marks.claim_started; // incoming only — "accept tapped" instant
  const joinStarted = t.marks.join_started;
  const joined = t.marks.joined_meeting;
  const firstAudio = t.marks.first_remote_audio;
  const firstVideo = t.marks.first_remote_video;
  const connected = t.marks.connected;

  const metrics = {
    direction: t.direction,
    callType: t.callType,
    provider: t.provider,
    outcome,
    callId: t.callId ?? null,
    sessionId: t.sessionId ?? null,
    failureReason: outcome === "failed" ? t.failureReason : undefined,
    // Raw per-stage offsets from call_button_tapped, ms — lets a slow log
    // reader see exactly where time went without doing the subtraction
    // themselves.
    stagesMs: Object.fromEntries(
      (Object.entries(t.marks) as [CallLatencyStage, number][]).map(([k, v]) => [k, ms(tapped, v)]),
    ),
    // Named derived metrics from the brief (section 3).
    ringingLatencyMs: ms(tapped, joined), // caller-side: tap -> our own join completes (proxy for "started ringing the other side")
    acceptToAudioLatencyMs: accepted !== undefined ? ms(accepted, firstAudio) : ms(joinStarted, firstAudio),
    acceptToVideoLatencyMs: accepted !== undefined ? ms(accepted, firstVideo) : ms(joinStarted, firstVideo),
    totalSetupLatencyMs: ms(tapped, connected),
    // PHASE 4 — every value below is computed ONLY from marks that were
    // actually recorded; a missing stage yields null, never an estimate.
    // The headline KPI for the next phase is acceptToRemoteAudioPlayingMs.
    signalingReadyMs: ms(tapped, t.marks.signaling_ready),
    inviteSentMs: ms(tapped, t.marks.invite_sent),
    acceptToAcceptSentMs: ms(t.marks.accept_pressed, t.marks.accept_sent),
    acceptToTokenMs: ms(t.marks.accept_pressed, t.marks.token_received),
    tokenToLivekitConnectedMs: ms(t.marks.token_received, t.marks.livekit_connected),
    livekitToRemoteTrackMs: ms(t.marks.livekit_connected, t.marks.remote_track_received),
    remoteTrackToAudioPlayingMs: ms(t.marks.remote_track_received, t.marks.remote_audio_playing),
    acceptToRemoteAudioPlayingMs: ms(t.marks.accept_pressed, t.marks.remote_audio_playing),
  };

  // MEASUREMENT FIX (found while verifying Phase 4): telemetry.logInfo()
  // flattens a non-Error `extra` object to `{ raw: <JSON truncated to 200
  // chars> }` AFTER key-name redaction — so this metrics object arrived in
  // the ring buffer cut off mid-way, and every key containing "token"
  // (token_requested / token_received / acceptToTokenMs…) had its value
  // replaced with "[redacted]". The numbers this module exists to produce
  // were therefore mostly unreadable. The MESSAGE string is neither
  // truncated nor key-redacted (only JWT/Bearer-shaped substrings are), so
  // the full summary is carried there as a compact `name=ms` line. The
  // object is still passed as `extra` for dev-console echo.
  logInfo("call.latency", `${t.direction} ${t.callType ?? "unknown"} call ${outcome} ${latencySummaryLine(t.provider, metrics)}`, metrics, t.traceId);
  if (current === t) current = null;
}

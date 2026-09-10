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
 * no native-side WebRTC or Daily.co client. So every stage the brief asked
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
 *     brief's list: Daily's public JS SDK does not expose ICE gathering/
 *     connection transitions as first-class events the way raw WebRTTC's
 *     RTCPeerConnection does — only join()/joined-meeting and the
 *     network-quality-change / network-connection events used elsewhere in
 *     useDailyCall.ts. Not invented here per that file's own "do not
 *     invent unsupported Daily APIs" rule.
 *
 * Everything else — call_button_tapped through connected, plus
 * claim/token/room sub-stages — is recorded from the real call sites in
 * CallContext.tsx, Calls.tsx, Chat.tsx, and useDailyCall.ts.
 *
 * DESIGN: DuoSpace is 1:1 calling with one call in flight at a time (see
 * DuoSpaceConnectionService.kt's own "single slot, not a list" comment on
 * the Android side) — so rather than thread an explicit trace id through
 * every call site (CallContext, Calls.tsx/Chat.tsx, and useDailyCall.ts,
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
 *  what's deliberately excluded and why. */
export type CallLatencyStage =
  | "call_button_tapped"
  | "call_session_created" // call_history row insert resolved (outgoing) / accept dispatched (incoming)
  | "daily_room_requested"
  | "daily_room_ready"
  | "token_requested"
  | "token_ready"
  | "claim_started" // incoming (accept) only
  | "claim_completed" // incoming (accept) only
  | "join_started" // call.join() invoked
  | "joined_meeting" // Daily "joined-meeting" event
  | "remote_participant_detected" // Daily "participant-joined" / already-present-on-join
  | "first_remote_audio"
  | "first_remote_video"
  | "connected"; // this device's own UI considers the call live

interface Trace {
  traceId: string;
  direction: "outgoing" | "incoming";
  callType: "video" | "voice" | null;
  marks: Partial<Record<CallLatencyStage, number>>;
  finished: boolean;
}

let current: Trace | null = null;

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Start timing a new call attempt. Call this at the earliest real moment
 *  a call begins — the tap on Call, or the moment an incoming call's
 *  Accept is tapped — before any network work starts. */
export function beginTrace(direction: "outgoing" | "incoming", callType: "video" | "voice" | null): string {
  const traceId = `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  current = { traceId, direction, callType, marks: {}, finished: false };
  current.marks.call_button_tapped = now();
  return traceId;
}

/** Record a stage timestamp against the current trace. `traceId` is
 *  optional and only used as a staleness guard — if a newer trace has
 *  since started (this call attempt was superseded), the mark is silently
 *  dropped rather than corrupting the new trace's timeline. Safe to call
 *  with no active trace at all (e.g. useDailyCall's event handlers can
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
}

export function currentTraceId(): string | null {
  return current?.traceId ?? null;
}

function ms(from?: number, to?: number): number | null {
  if (from === undefined || to === undefined) return null;
  return Math.round(to - from);
}

/** Finalize the current trace and log the derived latencies. Call once
 *  the call is genuinely connected (or has definitively failed — pass
 *  `outcome: "failed"` so a partial timeline is still logged instead of
 *  silently dropped). Safe to call with no active trace, or to call
 *  more than once (only the first call does anything). */
export function finishTrace(outcome: "connected" | "failed" | "cancelled", traceId?: string): void {
  if (!current || current.finished) return;
  if (traceId && traceId !== current.traceId) return;
  current.finished = true;
  const t = current;
  if (outcome === "connected" && t.marks.connected === undefined) {
    t.marks.connected = now();
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
    outcome,
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
  };

  logInfo("call.latency", `${t.direction} ${t.callType ?? "unknown"} call ${outcome}`, metrics, t.traceId);
  if (current === t) current = null;
}

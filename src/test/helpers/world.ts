/**
 * A tiny in-memory "world" for architecture tests: a fake call_history
 * (with the same claim/cancel/decline/end semantics the real RPCs have),
 * the REAL SignalingGateway authorizing against it, and the REAL
 * authorizeLiveKitToken() decision used by the livekit-token edge function.
 * There is intentionally NO Supabase Realtime object anywhere in here.
 */
import { SignalingGateway } from "../../../infrastructure/signaling/src/gateway";
import type { CallAuthorizer, CallFacts } from "../../../infrastructure/signaling/src/authorizer";
import { authorizeLiveKitToken, type LiveKitCallRow } from "../../../supabase/functions/_shared/livekitAuthz";
import { CallSignalingClient } from "@/lib/signalingEngine/CallSignalingClient";
import { LoopbackTransport } from "./loopbackTransport";
import { FakeClock } from "./signalingFakes";

export const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const MALLORY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

interface Row extends LiveKitCallRow { session_id: string; declined: boolean; call_type: "voice" | "video" }

export class FakeCallHistory implements CallAuthorizer {
  rows = new Map<string, Row>();
  partners = new Set<string>([`${ALICE}|${BOB}`, `${BOB}|${ALICE}`]);
  down = false;
  private n = 0;
  constructor(private now: () => number) {}

  insert(callerId: string, receiverId: string, over: Partial<Row> = {}): Row {
    this.n += 1;
    const id = over.id ?? `0000000${this.n}-0000-4000-8000-00000000000${this.n}`;
    const row: Row = {
      id, caller_id: callerId, receiver_id: receiverId, provider: "self_hosted", status: "in_progress",
      claimed_by: null, session_id: `5e550000-0000-4000-8000-00000000000${this.n}`,
      expires_at: new Date(this.now() + 40_000).toISOString(), declined: false, call_type: "voice", ...over,
    };
    this.rows.set(id, row);
    return row;
  }
  claim(id: string, userId: string): boolean {
    const r = this.rows.get(id);
    if (!r || r.status !== "in_progress" || r.claimed_by || r.receiver_id !== userId) return false;
    r.claimed_by = userId; return true;
  }
  cancel(id: string, userId: string): boolean {
    const r = this.rows.get(id);
    if (!r || r.status !== "in_progress" || r.claimed_by || r.caller_id !== userId) return false;
    r.status = "cancelled"; return true;
  }
  decline(id: string, userId: string): boolean {
    const r = this.rows.get(id);
    if (!r || r.status !== "in_progress" || r.claimed_by || r.receiver_id !== userId) return false;
    r.status = "missed"; r.declined = true; return true;
  }
  complete(id: string): void { const r = this.rows.get(id); if (r && r.status === "in_progress") r.status = "completed"; }

  async getCallFacts(callId: string): Promise<CallFacts | null> {
    if (this.down) throw new (await import("../../../infrastructure/signaling/src/authorizer")).AuthorizerUnavailableError("down");
    const r = this.rows.get(callId);
    if (!r) return null;
    return {
      callId: r.id, callerId: r.caller_id, receiverId: r.receiver_id, provider: r.provider ?? "daily", status: r.status,
      claimedBy: r.claimed_by ?? null, sessionId: r.session_id, expiresAt: r.expires_at ? Date.parse(r.expires_at) : null,
      callType: r.call_type, declined: r.declined, arePartners: this.partners.has(`${r.caller_id}|${r.receiver_id}`),
    };
  }
  /** What the livekit-token edge function decides for `userId` right now. */
  tokenFor(userId: string, id: string) {
    const r = this.rows.get(id);
    // Mirror livekit-token: facts come from signaling_get_call_facts,
    // including the mutual-partnership flag.
    const call = r ? { ...r, are_partners: this.partners.has(`${r.caller_id}|${r.receiver_id}`) } as LiveKitCallRow : null;
    return authorizeLiveKitToken({ userId, call, now: this.now() });
  }
}

export class World {
  clock = new FakeClock();
  db = new FakeCallHistory(() => Date.now());
  gateway = new SignalingGateway({ authorizer: this.db, messageLimiter: { check: () => true } });
  transports = new Map<string, LoopbackTransport>();
  clients = new Map<string, CallSignalingClient>();

  client(userId: string, over: { configured?: boolean } = {}): CallSignalingClient {
    const existing = this.clients.get(userId);
    if (existing) return existing;
    const transport = new LoopbackTransport(this.gateway, userId);
    this.transports.set(userId, transport);
    const c = new CallSignalingClient({
      userId, configured: over.configured ?? true, createTransport: () => transport, clock: this.clock,
      ackTimeoutMs: 200, offerDeadlineMs: 1_000, controlDeadlineMs: 5_000,
    });
    this.clients.set(userId, c);
    return c;
  }
  transport(userId: string): LoopbackTransport { this.client(userId); return this.transports.get(userId) as LoopbackTransport; }
}

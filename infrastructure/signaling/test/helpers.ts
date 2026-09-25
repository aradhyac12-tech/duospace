import { AuthorizerUnavailableError, type CallAuthorizer, type CallFacts } from "../src/authorizer.js";
import type { GatewayConnection } from "../src/session.js";
import { SignalingGateway } from "../src/gateway.js";
import type { AckFrame, ServerFrame, SignalingEventType, SignalingMessage } from "../src/types.js";

export const CALLER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const CALLEE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const STRANGER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const CALL_ID = "11111111-1111-4111-8111-111111111111";
export const CALL_ID_2 = "22222222-2222-4222-8222-222222222222";
export const SESSION = "5e5510a0-0000-4000-8000-000000000001";
export const SESSION_2 = "5e5510a0-0000-4000-8000-000000000002";

export class FakeConn implements GatewayConnection {
  sent: unknown[] = [];
  open = true;
  closedWith: [number | undefined, string | undefined] | null = null;
  send(data: string) { if (!this.open) throw new Error("closed"); this.sent.push(JSON.parse(data)); }
  close(code?: number, reason?: string) { this.open = false; this.closedWith = [code, reason]; }
  isOpen() { return this.open; }
  frames(): ServerFrame[] { return this.sent.filter((f) => (f as { kind?: string }).kind) as ServerFrame[]; }
  signals(): SignalingMessage[] { return this.sent.filter((f) => !(f as { kind?: string }).kind) as SignalingMessage[]; }
  acks(): AckFrame[] { return this.frames().filter((f) => f.kind === "ack") as AckFrame[]; }
  lastAck(): AckFrame { const a = this.acks(); return a[a.length - 1]; }
}

export function facts(over: Partial<CallFacts> = {}): CallFacts {
  return {
    callId: CALL_ID, callerId: CALLER, receiverId: CALLEE, provider: "self_hosted", status: "in_progress",
    claimedBy: null, sessionId: SESSION, expiresAt: null, callType: "voice", declined: false, arePartners: true,
    ...over,
  };
}

export class FakeAuthorizer implements CallAuthorizer {
  rows = new Map<string, CallFacts>();
  down = false;
  lookups = 0;
  async getCallFacts(callId: string): Promise<CallFacts | null> {
    this.lookups += 1;
    if (this.down) throw new AuthorizerUnavailableError("down");
    const r = this.rows.get(callId);
    return r ? { ...r } : null;
  }
  set(f: CallFacts) { this.rows.set(f.callId, f); }
}

export interface Harness {
  gw: SignalingGateway;
  auth: FakeAuthorizer;
  caller: FakeConn;
  callee: FakeConn;
  clock: { t: number };
  send: (as: string, conn: FakeConn, type: SignalingEventType, over?: Record<string, unknown>) => Promise<AckFrame>;
}

let seq = 0;
export function harness(opts: { connectCallee?: boolean; limiter?: (k: string) => boolean; ringTtlMs?: number } = {}): Harness {
  const auth = new FakeAuthorizer();
  auth.set(facts());
  const clock = { t: 1_000_000 };
  const gw = new SignalingGateway({
    authorizer: auth, now: () => clock.t, ringTtlMs: opts.ringTtlMs ?? 40_000,
    messageLimiter: { check: opts.limiter ?? (() => true) },
  });
  const caller = new FakeConn();
  const callee = new FakeConn();
  gw.connect(CALLER, caller);
  if (opts.connectCallee !== false) gw.connect(CALLEE, callee);
  const send = async (as: string, conn: FakeConn, type: SignalingEventType, over: Record<string, unknown> = {}) => {
    const recipientId = as === CALLER ? CALLEE : CALLER;
    seq += 1;
    const msg = { type, callId: CALL_ID, recipientId, sessionId: SESSION, msgId: `m${seq}`, ...over };
    await gw.handleRaw(as, conn, JSON.stringify(msg));
    return conn.lastAck();
  };
  return { gw, auth, caller, callee, clock, send };
}

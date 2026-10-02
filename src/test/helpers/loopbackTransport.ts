/**
 * LoopbackTransport — a SignalingTransport wired DIRECTLY to the real
 * SignalingGateway (infrastructure/signaling/src/gateway.ts) in-process:
 * no sockets, no Supabase Realtime, no network. This is what lets the
 * architecture tests prove the call-control path (offer → ring → accept →
 * ack to caller) works with Realtime entirely absent, using the SAME
 * gateway code that runs in production rather than a mock of it.
 */
import { SignalingGateway } from "../../../infrastructure/signaling/src/gateway";
import type { GatewayConnection } from "../../../infrastructure/signaling/src/session";
import type {
  OutboundSignal, SignalingConnectionState, SignalingMessage, SignalingTransport, TransportEvent,
} from "@/lib/signalingEngine/types";

export class LoopbackTransport implements SignalingTransport {
  private handlers = new Set<(e: TransportEvent) => void>();
  private state: SignalingConnectionState = "disconnected";
  private conn: (GatewayConnection & { alive: boolean }) | null = null;
  private everReady = false;
  /** When true, frames written by the client are silently lost in flight
   *  (simulates a half-open socket) — the client still sees a successful write. */
  dropOutbound = false;
  /** When set, connect() fails (gateway unreachable). */
  unreachable = false;
  writes: OutboundSignal[] = [];

  constructor(private readonly gateway: SignalingGateway, private readonly userId: string) {}

  async connect(): Promise<void> {
    if (this.isReady()) return;
    if (this.unreachable) { this.setState("reconnecting"); throw new Error("SIGNALING_CONNECT_TIMEOUT"); }
    this.attach();
  }

  /** Test control: gateway-side socket drop. */
  dropConnection(): void {
    if (!this.conn) return;
    this.conn.alive = false;
    this.gateway.disconnect(this.userId, this.conn);
    this.conn = null;
    this.setState("reconnecting");
  }

  /** Test control: come back (new socket, gateway sends ready + replays pending offers). */
  reconnect(): void {
    if (this.unreachable) return;
    this.attach();
  }

  private attach(): void {
    const conn = {
      alive: true,
      send: (data: string) => { if (this.conn === conn) queueMicrotask(() => this.onFrame(JSON.parse(data))); },
      close: () => { conn.alive = false; },
      isOpen: () => conn.alive,
    };
    this.conn = conn;
    this.gateway.connect(this.userId, conn); // sends {kind:"ready"} through conn.send
  }

  private onFrame(frame: Record<string, unknown>): void {
    switch (frame.kind) {
      case "ready": {
        this.setState("connected");
        const reconnected = this.everReady;
        this.everReady = true;
        this.emit({ kind: "ready", reconnected });
        return;
      }
      case "ack": this.emit({ kind: "ack", frame: frame as never }); return;
      case "state": this.emit({ kind: "state", frame: frame as never }); return;
      case "ping": return;
      default: this.emit({ kind: "signal", message: frame as unknown as SignalingMessage });
    }
  }

  /** Test control: hand the client a raw inbound signal as if the wire delivered it. */
  inject(message: SignalingMessage): void { this.emit({ kind: "signal", message }); }

  disconnect(): void { this.dropConnection(); this.setState("disconnected"); }
  isReady(): boolean { return this.state === "connected" && !!this.conn; }
  getConnectionState(): SignalingConnectionState { return this.state; }
  nudge(): void { /* tests drive reconnect() explicitly */ }

  sendFrame(message: OutboundSignal): boolean {
    if (!this.isReady() || !this.conn) return false;
    this.writes.push(message);
    if (this.dropOutbound) return true;
    const conn = this.conn;
    const raw = JSON.stringify({ ...message, senderId: this.userId, ts: Date.now() });
    void this.gateway.handleRaw(this.userId, conn, raw);
    return true;
  }

  subscribe(handler: (e: TransportEvent) => void): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  private setState(s: SignalingConnectionState): void {
    if (this.state === s) return;
    this.state = s;
    this.emit({ kind: "connection", state: s });
  }
  private emit(e: TransportEvent): void { for (const h of Array.from(this.handlers)) h(e); }
}

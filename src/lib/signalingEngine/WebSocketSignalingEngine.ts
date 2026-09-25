/**
 * WebSocketSignalingEngine — the browser/WebView transport for the Call
 * Gateway (infrastructure/signaling). Implements SignalingTransport.
 *
 * PHASE 4 changes vs the previous scaffold (each one fixes a real defect
 * found reading the code):
 *
 *  - FRESH TICKET PER ATTEMPT. The engine used to be handed one fixed URL
 *    (one ticket, valid 120s) and reconnect reused it, so any reconnect
 *    after two minutes was rejected 401 forever. It now takes `getUrl()`
 *    and calls it before EVERY connection attempt (ticket fetch included).
 *  - READY, NOT OPEN. "connected" means the server sent its `ready` frame
 *    (authenticated AND registered) — a bare WebSocket `open` does not
 *    count. connect() resolves on ready.
 *  - PERSISTENT WITH BACKOFF. After connect() the engine keeps the socket
 *    up: any unexpected close (or failed attempt, or missing ticket)
 *    schedules the next attempt with backoff until disconnect(). connect()
 *    itself still rejects after a timeout so a caller can fail fast; the
 *    retries continue in the background.
 *  - HALF-OPEN DETECTION. Browsers expose no protocol ping, so the server
 *    sends an application `ping` frame every ~15s; if nothing at all
 *    arrives for `heartbeatTimeoutMs` the socket is closed and re-opened.
 *  - TYPED FRAMES. ack/state/ready/signal frames are routed separately;
 *    nothing is silently discarded except unparseable or malformed input.
 *  - NO SILENT QUEUE. sendFrame() reports whether it wrote; queueing and
 *    retry policy live one level up (CallSignalingClient), where the
 *    caller can be told the outcome.
 *
 * NOT RUNTIME-VERIFIED against a live gateway — see src/test/
 * webSocketSignalingEngine.test.ts for what IS exercised (against a fake
 * socket).
 */
import { realClock, type Clock } from "./clock";
import {
  isWellFormedSignalingMessage,
  type OutboundSignal,
  type SignalingConnectionState,
  type SignalingMessage,
  type SignalingTransport,
  type TransportEvent,
} from "./types";

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15000];
const CONNECT_TIMEOUT_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 40_000;
const WS_OPEN = 1;

/** The slice of the WebSocket API the engine uses (lets tests inject a fake). */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}

export interface WebSocketSignalingEngineOptions {
  /** Resolves the full wss:// URL INCLUDING a freshly-fetched ticket.
   *  Called before every connection attempt. */
  getUrl: () => Promise<string>;
  userId: string;
  webSocketFactory?: (url: string) => WebSocketLike;
  clock?: Clock;
  connectTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  reconnectDelaysMs?: number[];
}

export class WebSocketSignalingEngine implements SignalingTransport {
  private readonly clock: Clock;
  private readonly factory: (url: string) => WebSocketLike;
  private readonly delays: number[];
  private readonly connectTimeoutMs: number;
  private readonly heartbeatTimeoutMs: number;

  /** The socket of the in-flight or live attempt. */
  private socket: WebSocketLike | null = null;
  /** True only after the server's `ready` frame on `socket`. */
  private socketReady = false;
  private cancelAttempt: (() => void) | null = null;
  private state: SignalingConnectionState = "disconnected";
  private handlers = new Set<(e: TransportEvent) => void>();
  private waiters = new Set<{ resolve: () => void; reject: (e: Error) => void; timer: unknown }>();

  private wanted = false;
  private looping = false;
  private everReady = false;
  private attempt = 0;
  private wake: (() => void) | null = null;
  private lastFrameAt = 0;
  /** Set when the server closed us with 4000 (a newer socket for the same
   *  user replaced this one — e.g. the account opened on another device).
   *  Auto-reconnect pauses so two devices don't evict each other forever;
   *  an explicit connect()/nudge() (user action, app resumed, network back)
   *  resumes it. */
  private superseded = false;
  private watchdog: unknown = null;

  constructor(private readonly opts: WebSocketSignalingEngineOptions) {
    this.clock = opts.clock ?? realClock;
    this.factory = opts.webSocketFactory ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.delays = opts.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
  }

  // ---- public ----------------------------------------------------------------

  connect(timeoutMs: number = this.connectTimeoutMs): Promise<void> {
    this.wanted = true;
    this.superseded = false;
    if (this.isReady()) return Promise.resolve();
    const p = new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => { this.clock.clearTimeout(waiter.timer); this.waiters.delete(waiter); resolve(); },
        reject: (e: Error) => { this.clock.clearTimeout(waiter.timer); this.waiters.delete(waiter); reject(e); },
        timer: this.clock.setTimeout(() => waiter.reject(new Error("SIGNALING_CONNECT_TIMEOUT")), timeoutMs),
      };
      this.waiters.add(waiter);
    });
    this.startLoop();
    // Someone is WAITING on this connection (e.g. accepting a call): skip the
    // remaining reconnect backoff (up to 15s) instead of sleeping through it.
    this.wake?.();
    return p;
  }

  disconnect(): void {
    this.wanted = false;
    this.stopWatchdog();
    for (const w of Array.from(this.waiters)) w.reject(new Error("SIGNALING_DISCONNECTED"));
    this.cancelAttempt?.(); // closes the socket and lets the loop unwind
    this.wake?.();
    this.socket = null;
    this.socketReady = false;
    this.setState("disconnected");
  }

  isReady(): boolean {
    return this.state === "connected" && this.socketReady && !!this.socket && this.socket.readyState === WS_OPEN;
  }

  getConnectionState(): SignalingConnectionState {
    return this.state;
  }

  sendFrame(message: OutboundSignal): boolean {
    if (!this.isReady() || !this.socket) return false;
    const full: SignalingMessage = { ...message, senderId: this.opts.userId, ts: this.clock.now() };
    try {
      this.socket.send(JSON.stringify(full));
      return true;
    } catch {
      return false;
    }
  }

  subscribe(handler: (e: TransportEvent) => void): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  nudge(): void {
    this.superseded = false;
    if (this.wanted && !this.isReady()) { this.startLoop(); this.wake?.(); }
  }

  /**
   * Network changed (Wi-Fi ↔ mobile data, back online): the old TCP socket
   * may be half-open and still look OPEN. The server pings every ~15s, so
   * if nothing has arrived for `maxSilenceMs` the socket is presumed dead
   * and replaced now (fresh ticket via getUrl) instead of waiting for the
   * 40s heartbeat watchdog.
   */
  checkLiveness(maxSilenceMs = 20_000): void {
    if (!this.wanted) return;
    if (this.isReady() && this.socket && this.clock.now() - this.lastFrameAt > maxSilenceMs) {
      try { this.socket.close(4002, "network_changed"); } catch { /* gone */ }
    }
    this.nudge();
  }

  // ---- connection loop ---------------------------------------------------------

  private startLoop(): void {
    if (this.looping) return;
    this.looping = true;
    void (async () => {
      try {
        while (this.wanted) {
          await this.attemptOnce();
          if (!this.wanted || this.superseded) break;
          const delay = this.delays[Math.min(this.attempt, this.delays.length - 1)];
          this.attempt += 1;
          await new Promise<void>((resolve) => {
            const t = this.clock.setTimeout(() => { this.wake = null; resolve(); }, delay);
            this.wake = () => { this.clock.clearTimeout(t); this.wake = null; resolve(); };
          });
        }
      } finally {
        this.looping = false;
      }
    })();
  }

  /** One connection attempt; resolves when that socket is gone (whether it
   *  ever became ready or not). */
  private async attemptOnce(): Promise<void> {
    this.setState(this.everReady || this.attempt > 0 ? "reconnecting" : "connecting");
    let url: string;
    try {
      url = await this.opts.getUrl(); // fresh ticket every time
    } catch {
      return;
    }
    if (!this.wanted) return;

    await new Promise<void>((resolve) => {
      let done = false;
      let socket: WebSocketLike;
      try {
        socket = this.factory(url);
      } catch {
        resolve();
        return;
      }
      this.socket = socket;
      this.socketReady = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.clock.clearTimeout(connectTimer);
        if (this.cancelAttempt === finish) this.cancelAttempt = null;
        if (this.socket === socket) {
          this.socket = null;
          this.socketReady = false;
          this.stopWatchdog();
          if (this.wanted) this.setState("reconnecting");
        }
        socket.onmessage = null; socket.onclose = null; socket.onerror = null;
        try { socket.close(); } catch { /* already closed */ }
        resolve();
      };
      this.cancelAttempt = finish;
      const connectTimer = this.clock.setTimeout(finish, this.connectTimeoutMs);

      socket.onmessage = (ev) => {
        if (this.socket !== socket) return; // superseded / cancelled socket
        let parsed: unknown;
        try { parsed = JSON.parse(String(ev.data)); } catch { return; }
        this.lastFrameAt = this.clock.now();
        this.route(socket, parsed, () => { this.clock.clearTimeout(connectTimer); });
      };
      socket.onclose = (ev?: unknown) => {
        if (this.socket === socket && (ev as { code?: number } | undefined)?.code === 4000) this.superseded = true;
        finish();
      };
      socket.onerror = () => { /* close follows; finish() runs there */ };
    });
  }

  private route(socket: WebSocketLike, frame: unknown, onReady: () => void): void {
    if (!frame || typeof frame !== "object") return;
    const f = frame as Record<string, unknown>;
    switch (f.kind) {
      case "ready": {
        if (this.socket !== socket || this.socketReady) return;
        onReady();
        this.socketReady = true;
        const reconnected = this.everReady;
        this.everReady = true;
        this.attempt = 0;
        this.setState("connected");
        this.startWatchdog();
        for (const w of Array.from(this.waiters)) w.resolve();
        this.emit({ kind: "ready", reconnected });
        return;
      }
      case "ack":
        if (this.socketReady && typeof f.msgId === "string") this.emit({ kind: "ack", frame: f as never });
        return;
      case "state":
        if (this.socketReady && typeof f.callId === "string") this.emit({ kind: "state", frame: f as never });
        return;
      case "ping":
        return; // liveness only — lastFrameAt already updated
      default:
        if (this.socketReady && isWellFormedSignalingMessage(frame)) {
          this.emit({ kind: "signal", message: frame });
        }
    }
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    const tick = () => {
      if (!this.socket || !this.wanted) return;
      if (this.clock.now() - this.lastFrameAt > this.heartbeatTimeoutMs) {
        // Half-open: nothing (not even the server ping) for too long.
        try { this.socket.close(4001, "heartbeat_timeout"); } catch { /* gone */ }
        return;
      }
      this.watchdog = this.clock.setTimeout(tick, Math.max(1_000, Math.floor(this.heartbeatTimeoutMs / 4)));
    };
    this.watchdog = this.clock.setTimeout(tick, Math.max(1_000, Math.floor(this.heartbeatTimeoutMs / 4)));
  }

  private stopWatchdog(): void {
    if (this.watchdog !== null) { this.clock.clearTimeout(this.watchdog); this.watchdog = null; }
  }

  private setState(next: SignalingConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.emit({ kind: "connection", state: next });
  }

  private emit(e: TransportEvent): void {
    for (const h of Array.from(this.handlers)) {
      try { h(e); } catch { /* one bad subscriber must not break the socket */ }
    }
  }
}

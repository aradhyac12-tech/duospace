import type { Clock } from "@/lib/signalingEngine/clock";
import type { WebSocketLike } from "@/lib/signalingEngine/WebSocketSignalingEngine";

/** Deterministic clock: time only moves when a test calls advance(). */
export class FakeClock implements Clock {
  private t = 1_000_000;
  private timers: { id: number; at: number; fn: () => void }[] = [];
  private seq = 0;
  now() { return this.t; }
  setTimeout(fn: () => void, ms: number) {
    const id = ++this.seq;
    this.timers.push({ id, at: this.t + Math.max(0, ms), fn });
    return id;
  }
  clearTimeout(h: unknown) { this.timers = this.timers.filter((x) => x.id !== h); }
  pending() { return this.timers.length; }
  /** Let promise continuations run. */
  async flush() { for (let i = 0; i < 6; i++) await new Promise<void>((r) => setImmediate(r)); }
  async advance(ms: number) {
    const target = this.t + ms;
    await this.flush();
    for (;;) {
      const due = this.timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x !== due);
      this.t = Math.max(this.t, due.at);
      due.fn();
      await this.flush();
    }
    this.t = target;
    await this.flush();
  }
}

/** Scriptable WebSocket stand-in. Tests drive open/frames/close by hand. */
export class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: WebSocketLike["onopen"] = null;
  onmessage: WebSocketLike["onmessage"] = null;
  onclose: WebSocketLike["onclose"] = null;
  onerror: WebSocketLike["onerror"] = null;
  closeCalls: Array<[number | undefined, string | undefined]> = [];
  constructor(public url: string) { FakeSocket.instances.push(this); }
  send(data: string) { if (this.readyState !== 1) throw new Error("not open"); this.sent.push(JSON.parse(data)); }
  close(code?: number, reason?: string) {
    this.closeCalls.push([code, reason]);
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
  // ---- test drivers
  open() { this.readyState = 1; this.onopen?.(); }
  frame(obj: unknown) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  serverReady(userId = "u") { this.open(); this.frame({ kind: "ready", userId, serverTime: 1 }); }
  drop() { this.readyState = 3; this.onclose?.(); }
}

/**
 * Regression: "cannot add `postgres_changes` callbacks for realtime:recoverable-call:… after
 * `subscribe()`" crashed the Calls screen (ErrorBoundary, DS-UNKNOWN-001).
 * The fake below reproduces supabase-js: channel(topic) returns the EXISTING channel for a
 * topic until removeChannel() has actually finished (it is async), and .on() after .subscribe() throws.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const { fake } = vi.hoisted(() => {
  class FakeChannel {
    subscribed = false;
    constructor(public topic: string) {}
    on() {
      if (this.subscribed) throw new Error(`cannot add \`postgres_changes\` callbacks for realtime:${this.topic} after \`subscribe()\`.`);
      return this;
    }
    subscribe() { this.subscribed = true; return this; }
  }
  const registry = new Map<string, FakeChannel>();
  const fake = {
    registry,
    created: [] as string[],
    channel(topic: string) {
      const hit = registry.get(topic);
      if (hit) return hit;
      const ch = new FakeChannel(topic);
      registry.set(topic, ch); fake.created.push(topic);
      return ch;
    },
    // async removal, like the real client: the topic stays registered for a tick
    removeChannel(ch: FakeChannel) { return new Promise<void>((r) => setTimeout(() => { registry.delete(ch.topic); r(); }, 10)); },
    from() {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "or", "eq", "is", "gte", "order", "limit"]) q[m] = () => q;
      q.maybeSingle = async () => ({ data: null });
      return q;
    },
  };
  return { fake };
});

vi.mock("@/integrations/supabase/appClient", () => ({ supabase: fake }));

import { useRecoverableCall } from "@/hooks/useRecoverableCall";

beforeEach(() => { fake.registry.clear(); fake.created.length = 0; });

describe("useRecoverableCall realtime channels", () => {
  it("re-running the effect for the SAME user (remount / dep change) never throws", async () => {
    const opts = { userId: "55b10d97-bc5f-4fbd-a4e4-83ad02a7e7c2", busy: false, refreshKey: "a" };
    const first = renderHook(() => useRecoverableCall(opts));
    await act(async () => {});
    first.unmount();               // removeChannel is still pending here
    expect(() => renderHook(() => useRecoverableCall(opts))).not.toThrow();
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  });

  it("uses a fresh topic for every effect run", async () => {
    const opts = { userId: "u1", busy: false, refreshKey: "a" };
    const h1 = renderHook(() => useRecoverableCall(opts));
    h1.unmount();
    const h2 = renderHook(() => useRecoverableCall(opts));
    h2.unmount();
    expect(new Set(fake.created).size).toBe(fake.created.length);
    expect(fake.created.length).toBe(4); // caller_id + receiver_id, twice
  });

  it("a realtime failure degrades to polling instead of crashing the screen", async () => {
    const orig = fake.channel;
    fake.channel = () => { throw new Error("realtime unavailable"); };
    try {
      expect(() => renderHook(() => useRecoverableCall({ userId: "u2", busy: false, refreshKey: "a" }))).not.toThrow();
    } finally { fake.channel = orig; }
  });
});

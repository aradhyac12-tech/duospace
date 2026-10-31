import { describe, it, expect, vi } from "vitest";
import { moveUpcoming } from "@/lib/music/queueLogic";
import { createTopUpGate } from "@/lib/music/topUpGate";

const q = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (x: { id: string }[]) => x.map((t) => t.id).join("");

describe("moveUpcoming", () => {
  it("moves an upcoming track one slot, never the current/earlier tracks, never above the current", () => {
    const base = q("a", "b", "c", "d"); // current = b
    expect(ids(moveUpcoming(base, "b", "d", -1))).toBe("abdc");
    expect(ids(moveUpcoming(base, "b", "c", +1))).toBe("abdc");
    expect(moveUpcoming(base, "b", "c", -1)).toBe(base);   // would land on the current slot: no-op (same array)
    expect(moveUpcoming(base, "b", "a", +1)).toBe(base);   // earlier/history: no-op
    expect(moveUpcoming(base, "b", "b", +1)).toBe(base);   // current: no-op
    expect(moveUpcoming(base, "b", "d", +1)).toBe(base);   // already last
    expect(moveUpcoming(base, "b", "zz", +1)).toBe(base);  // unknown id
  });
  it("does not mutate its input and keeps the playing track in place", () => {
    const base = q("a", "b", "c", "d", "e");
    const copy = base.slice();
    const out = moveUpcoming(base, "b", "e", -2);
    expect(base).toEqual(copy);
    expect(ids(out)).toBe("abecd");
    expect(out[1].id).toBe("b");
  });
  it("treats everything except the current as upcoming when the current is not in the queue", () => {
    expect(ids(moveUpcoming(q("x", "y", "z"), "gone", "z", -1))).toBe("xzy");
  });
});

describe("createTopUpGate", () => {
  it("shares one in-flight lookup per key and applies once", async () => {
    const gate = createTopUpGate<string>();
    const load = vi.fn(async () => ["n1"]);
    const apply = vi.fn();
    const [a, b] = [gate.run("t1", load, () => true, apply), gate.run("t1", load, () => true, apply)];
    expect(await a).toEqual(["n1"]); expect(await b).toEqual(["n1"]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(gate.inFlightKey()).toBeNull();
  });
  it("a different track starts its own lookup, and a stale result is discarded (never applied)", async () => {
    const gate = createTopUpGate<string>();
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    let currentId = "t1";
    const apply = vi.fn();
    const first = gate.run("t1", async () => { await slow; return ["old"]; }, () => currentId === "t1", apply);
    currentId = "t2";                                   // person skipped
    const second = gate.run("t2", async () => ["new"], () => currentId === "t2", apply);
    release();
    expect(await first).toEqual([]);
    expect(await second).toEqual(["new"]);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(["new"]);
  });
  it("a failing lookup resolves to [] and clears the slot", async () => {
    const gate = createTopUpGate<string>();
    expect(await gate.run("t", async () => { throw new Error("x"); }, () => true, vi.fn())).toEqual([]);
    expect(gate.inFlightKey()).toBeNull();
  });
  it("frees the slot even when load() throws synchronously (no stuck in-flight entry)", async () => {
    const gate = createTopUpGate<string>();
    const bad = (() => { throw new Error("boom"); }) as unknown as () => Promise<string[]>;
    expect(await gate.run("t1", bad, () => true, () => {})).toEqual([]);
    expect(gate.inFlightKey()).toBeNull();
    expect(await gate.run("t1", async () => ["ok"], () => true, () => {})).toEqual(["ok"]);
  });
});

import { describe, it, expect } from "vitest";

/**
 * Regression for "Maximum call stack size exceeded" (DuoSpace crash report 2026-10-15):
 * supabase removeChannel() re-emits CLOSED into the same subscribe callback. A handler that
 * calls removeChannel() BEFORE detaching its reference recurses forever. The fixed pattern
 * detaches first, so the nested call hits the guard and returns.
 */
describe("realtime CLOSED re-entrancy pattern", () => {
  it("detach-first handler terminates when removeChannel re-emits CLOSED", () => {
    let live: object | null = {};
    const ch = live;
    let calls = 0;
    const removeChannel = (_c: object) => { onStatus("CLOSED"); };
    function onStatus(_s: string) {
      calls++;
      if (calls > 50) throw new RangeError("Maximum call stack size exceeded");
      if (live !== ch) return;
      live = null;
      removeChannel(ch!);
    }
    onStatus("CLOSED");
    expect(calls).toBe(2);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeEdgeFunction = vi.fn(() => Promise.reject(new Error("400 expected")));
vi.mock("@/lib/edgeFunction", () => ({ invokeEdgeFunction }));

describe("musicWarmup", () => {
  beforeEach(() => { invokeEdgeFunction.mockClear(); vi.resetModules(); vi.useFakeTimers(); });

  it("sends a quiet EMPTY streams batch (primes isolate + client_id, resolves nothing)", async () => {
    const { warmMusicBackend } = await import("@/lib/music/musicWarmup");
    warmMusicBackend(true);
    expect(invokeEdgeFunction).toHaveBeenCalledWith("soundcloud-search", expect.objectContaining({
      body: { mode: "streams", trackIds: [] }, quiet: true, retry: false,
    }));
  });

  it("de-duplicates within the gap, and forces through when asked", async () => {
    const { warmMusicBackend } = await import("@/lib/music/musicWarmup");
    warmMusicBackend(true); warmMusicBackend(); warmMusicBackend();
    expect(invokeEdgeFunction).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(46_000);
    warmMusicBackend();
    expect(invokeEdgeFunction).toHaveBeenCalledTimes(2);
  });

  it("keep-warm re-warms on foreground and the disposer removes listeners", async () => {
    const { startMusicKeepWarm } = await import("@/lib/music/musicWarmup");
    const stop = startMusicKeepWarm();
    expect(invokeEdgeFunction).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(invokeEdgeFunction).toHaveBeenCalledTimes(2);
    stop();
    vi.advanceTimersByTime(60_000);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(invokeEdgeFunction).toHaveBeenCalledTimes(2);
  });
});

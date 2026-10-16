/** Runtime signaling URL: builds without VITE_SIGNALING_URL get it from the backend. */
import { describe, it, expect, beforeEach, vi } from "vitest";

beforeEach(() => { vi.resetModules(); localStorage.clear(); vi.unstubAllEnvs(); });

describe("runtime signaling URL", () => {
  it("no build URL → loads from backend, validates wss://, caches for next launch", async () => {
    vi.stubEnv("VITE_SIGNALING_URL", "");
    const m = await import("@/lib/signalingEngine/signalingConfig");
    expect(m.resolveSignalingUrl()).toBeNull();
    expect(await m.loadRuntimeSignalingUrl(async () => ({ signalingUrl: "wss://signal.example.org" }))).toBe("wss://signal.example.org");
    expect(localStorage.getItem("duo_signaling_url_v1")).toBe("wss://signal.example.org");
    vi.resetModules();
    const again = await import("@/lib/signalingEngine/signalingConfig");
    expect(again.resolveSignalingUrl()).toBe("wss://signal.example.org"); // instant on relaunch
  });

  it("rejects anything that is not a wss:// URL (http, ws, garbage)", async () => {
    vi.stubEnv("VITE_SIGNALING_URL", "");
    const m = await import("@/lib/signalingEngine/signalingConfig");
    for (const bad of ["http://x.org", "ws://x.org", "javascript:alert(1)", "", null]) m.setRuntimeSignalingUrl(bad);
    expect(m.resolveSignalingUrl()).toBeNull();
  });

  it("a build-time URL always wins and the backend is not asked", async () => {
    vi.stubEnv("VITE_SIGNALING_URL", "wss://build.example.org");
    const m = await import("@/lib/signalingEngine/signalingConfig");
    const fetchConfig = vi.fn(async () => ({ signalingUrl: "wss://other.example.org" }));
    expect(await m.loadRuntimeSignalingUrl(fetchConfig)).toBe("wss://build.example.org");
    expect(fetchConfig).not.toHaveBeenCalled();
  });

  it("backend without a URL → stays unconfigured (clear error, no crash)", async () => {
    vi.stubEnv("VITE_SIGNALING_URL", "");
    const m = await import("@/lib/signalingEngine/signalingConfig");
    expect(await m.loadRuntimeSignalingUrl(async () => ({ signalingUrl: null }))).toBeNull();
    expect(await m.loadRuntimeSignalingUrl(async () => { throw new Error("offline"); })).toBeNull();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
const capture = vi.fn();
const logWarn = vi.fn();
vi.mock("@/integrations/supabase/appClient", () => ({ supabase: { functions: { invoke } } }));
vi.mock("@/lib/errors/errorManager", () => ({ errorManager: { capture } }));
vi.mock("@/lib/telemetry", async (orig) => ({ ...(await orig() as object), logWarn, logInfo: vi.fn() }));

const httpError = () => ({
  message: "Edge Function returned a non-2xx status code",
  context: { status: 400, text: async () => JSON.stringify({ error: "callId is required" }) },
});

describe("invokeEdgeFunction quiet mode (call warm-up 400)", () => {
  beforeEach(() => { invoke.mockReset(); capture.mockReset(); logWarn.mockReset(); });

  it("still throws but does not log/capture when quiet", async () => {
    invoke.mockResolvedValue({ data: null, error: httpError() });
    const { invokeEdgeFunction } = await import("@/lib/edgeFunction");
    await expect(invokeEdgeFunction("livekit-token", { body: {}, quiet: true })).rejects.toMatchObject({ status: 400 });
    expect(capture).not.toHaveBeenCalled();
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("non-quiet calls keep reporting DS-API-001", async () => {
    invoke.mockResolvedValue({ data: null, error: httpError() });
    const { invokeEdgeFunction } = await import("@/lib/edgeFunction");
    await expect(invokeEdgeFunction("livekit-token", { body: {} })).rejects.toBeTruthy();
    expect(capture).toHaveBeenCalledWith("DS-API-001", expect.anything());
  });
});

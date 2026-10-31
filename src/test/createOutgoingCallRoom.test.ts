import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeEdgeFunctionMock = vi.fn();
vi.mock("@/lib/edgeFunction", () => ({
  invokeEdgeFunction: (...args: unknown[]) => invokeEdgeFunctionMock(...args),
}));

import { createOutgoingCallRoom } from "@/lib/callEngine/createOutgoingCallRoom";

beforeEach(() => {
  invokeEdgeFunctionMock.mockReset();
});

describe("createOutgoingCallRoom", () => {
  it("self_hosted: awaits call_history insertion BEFORE returning (ordering contract)", async () => {
    const callOrder: string[] = [];
    const insertCallHistoryForSelfHosted = vi.fn(async ({ callId, roomName }: { callId: string; roomName: string }) => {
      callOrder.push("insert:" + roomName);
      return { id: callId, sessionId: "sess-1" };
    });
    const result = await createOutgoingCallRoom("self_hosted", { userId: "user-1", insertCallHistoryForSelfHosted });
    callOrder.push("returned");
    expect(callOrder[0]).toMatch(/^insert:/);
    expect(callOrder[1]).toBe("returned");
    expect(result.provider).toBe("self_hosted");
    if (result.provider === "self_hosted") {
      expect(result.sessionId).toBe("sess-1");
      expect(result.roomName).toBe(`duo-call-${result.roomId}`); // derived, never client-invented
    }
    expect(invokeEdgeFunctionMock).not.toHaveBeenCalled(); // creating the session needs no edge function
  });

  it("self_hosted: throws a clear programmer error if the insert callback is missing", async () => {
    await expect(createOutgoingCallRoom("self_hosted", { userId: "user-1" })).rejects.toThrow(/insertCallHistoryForSelfHosted/);
  });

  it("self_hosted: room name is derived from the call id", async () => {
    let captured = { callId: "", roomName: "" };
    await createOutgoingCallRoom("self_hosted", {
      userId: "user-1",
      insertCallHistoryForSelfHosted: async (row) => { captured = row; return { id: row.callId, sessionId: "s" }; },
    });
    expect(captured.roomName).not.toContain("https://");
    expect(captured.roomName).toBe(`duo-call-${captured.callId}`);
    expect(captured.callId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("self_hosted: refuses a row whose id differs from the requested call id, or that has no session id", async () => {
    await expect(createOutgoingCallRoom("self_hosted", {
      userId: "u", insertCallHistoryForSelfHosted: async () => ({ id: "someone-elses", sessionId: "s" }),
    })).rejects.toThrow(/different id/);
    await expect(createOutgoingCallRoom("self_hosted", {
      userId: "u", insertCallHistoryForSelfHosted: async ({ callId }) => ({ id: callId, sessionId: "" }),
    })).rejects.toThrow(/session_id/);
  });
});

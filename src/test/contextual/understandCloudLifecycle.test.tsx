/** UnderstandSheet cloud lifecycle (jsdom; NOT a device). Deterministic Understand never calls the gateway. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const gateway = vi.fn();
vi.mock("@/lib/ai/cloud/gatewayClient", () => ({ callAiGateway: (...a: unknown[]) => gateway(...a), CLOUD_AI_DISCLOSURE: "x" }));
vi.mock("@/lib/relationship/production", () => ({ buildProductionRelationshipDeps: () => ({ gate: { hasConsent: async () => true }, backend: { get: async () => null, set: async () => {} } }) }));
vi.mock("@/lib/privacy/consent", () => ({ grantConsent: vi.fn(async () => {}), hasConsent: async () => true }));
vi.mock("@/components/ui/drawer", () => ({
  Drawer: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DrawerDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));

import UnderstandSheet from "@/components/chat/UnderstandSheet";
import { _resetCloudUnderstandInflight } from "@/lib/relationship/contextual/cloudUnderstand";

const out = (summary: string, evidence: string[]) => ({ ok: true, result: { language: { code: "en", script: "latin", codeMixed: false }, summary, intent: "REQUEST", evidence, why: null, offerReply: true, cannotTell: false, confidence: "MEDIUM" }, provider: "p", fallbackUsed: false, remaining: 3 });
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const Sheet = (p: { messageId: string; text: string }) => <MemoryRouter><UnderstandSheet open userId="u" onHelpReply={vi.fn()} onClose={vi.fn()} {...p} /></MemoryRouter>;
const ASK = "Look closer (uses an AI service)";

beforeEach(() => { gateway.mockReset(); _resetCloudUnderstandInflight(); });

describe("UnderstandSheet cloud lifecycle", () => {
  it("opening (deterministic Understand) makes NO gateway call", async () => {
    render(<Sheet messageId="m1" text="Can you just tell me next time?" />);
    await screen.findByText(/They asked/);
    expect(gateway).not.toHaveBeenCalled();
  });
  it("tap → one gateway call, result labelled as an AI reading", async () => {
    gateway.mockResolvedValue(out("They'd like to be told in advance.", ["tell me next time"]));
    render(<Sheet messageId="m1" text="Can you just tell me next time?" />);
    fireEvent.click(await screen.findByText(ASK));
    await screen.findByText("They'd like to be told in advance.");
    expect(gateway).toHaveBeenCalledTimes(1);
    expect(gateway.mock.calls[0][0]).toBe("UNDERSTAND");
    expect(screen.getByText(/possible interpretation, not a fact/)).toBeTruthy();
  });
  it("a late result for message 1 never appears after switching to message 2", async () => {
    const d = deferred<unknown>();
    gateway.mockReturnValueOnce(d.promise);
    const { rerender } = render(<Sheet messageId="m1" text="Can you just tell me next time?" />);
    fireEvent.click(await screen.findByText(ASK));
    await waitFor(() => expect(gateway).toHaveBeenCalledTimes(1));
    rerender(<Sheet messageId="m2" text="Can you call me tonight?" />);
    await act(async () => { d.resolve(out("Reading for message ONE.", ["tell me next time"])); });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByText("Reading for message ONE.")).toBeNull();
  });
});

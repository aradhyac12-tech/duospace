/**
 * Component-level lifecycle guards for QuickReplySheet (jsdom; NOT a device).
 * Core claim under test: ONE gateway call per opened message, no stale results, no double charge.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const gateway = vi.fn();
const consumeAiQuota = vi.fn(async () => ({ allowed: true, remaining: 9, reset_at: null, reason: "ok" }));
const supportResponse = vi.fn();
const consents = { cloud: true, insights: true };

vi.mock("@/lib/ai/cloud/gatewayClient", () => ({ callAiGateway: (...a: unknown[]) => gateway(...a), CLOUD_AI_DISCLOSURE: "x" }));
vi.mock("@/hooks/useAiQuota", () => ({ consumeAiQuota: (...a: unknown[]) => (consumeAiQuota as (...x: unknown[]) => unknown)(...a) }));
vi.mock("@/lib/relationship/production", () => ({ buildProductionRelationshipDeps: () => ({ gate: { hasConsent: async () => true }, backend: { get: async () => null, set: async () => {} } }) }));
vi.mock("@/lib/relationship/service", () => ({ createRelationshipAIService: () => ({ supportResponse: (...a: unknown[]) => supportResponse(...a) }) }));
vi.mock("@/lib/privacy/consent", () => ({
  grantConsent: vi.fn(async () => {}),
  hasConsent: async (_u: string, f: string) => (f === "CLOUD_AI_PROCESSING" ? consents.cloud : consents.insights),
}));
vi.mock("@/components/ui/drawer", () => ({
  Drawer: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DrawerDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));

import QuickReplySheet from "@/components/chat/QuickReplySheet";
import { _resetCloudReplyInflight } from "@/lib/relationship/contextual/cloudReply";

const local = (text = "On-device reply here.", usedModel = false) => ({ usedModel, support: { possibleResponse: text, safetyHold: false, refusal: null, insufficientInformation: false, notes: [], clarifyingQuestion: "?", limitedMode: false } });
const cloudOk = (text: string) => ({ ok: true, result: { suggestions: [{ text, mode: "normal", respondsTo: "x" }], insufficientContext: false }, provider: "p", fallbackUsed: false, remaining: 5 });
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

const Sheet = (p: Partial<React.ComponentProps<typeof QuickReplySheet>> = {}) => (
  <MemoryRouter><QuickReplySheet open userId="u" partnerText="Can you call me tonight?" messageId="m1" recent={[]} onUse={vi.fn()} onClose={vi.fn()} {...p} /></MemoryRouter>
);

beforeEach(() => {
  gateway.mockReset(); consumeAiQuota.mockClear(); supportResponse.mockReset(); _resetCloudReplyInflight();
  consents.cloud = true; consents.insights = true;
  supportResponse.mockResolvedValue(local());
});

describe("QuickReplySheet generation lifecycle", () => {
  it("opening makes exactly ONE gateway call, labelled as AI-written, and never charges client-side", async () => {
    gateway.mockResolvedValue(cloudOk("Sure, I can call at 8."));
    render(<Sheet />);
    await screen.findByText("Sure, I can call at 8.");
    expect(screen.getByText("Written by an AI service")).toBeTruthy();
    expect(gateway).toHaveBeenCalledTimes(1);
    expect(gateway.mock.calls[0][0]).toBe("QUICK_REPLY");
    expect(consumeAiQuota).not.toHaveBeenCalled();
  });

  it("ordinary rerenders (new `recent` array identity, same message) do not create another generation", async () => {
    gateway.mockResolvedValue(cloudOk("Reply one."));
    const { rerender } = render(<Sheet recent={[]} />);
    await screen.findByText("Reply one.");
    for (let i = 0; i < 3; i++) rerender(<Sheet recent={[{ from: "USER", text: "hi" }]} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(gateway).toHaveBeenCalledTimes(1);
    expect(supportResponse).toHaveBeenCalledTimes(1);
  });

  it("repeated taps on Another start at most ONE extra call (identical request shares the in-flight promise)", async () => {
    const d = deferred<unknown>();
    gateway.mockResolvedValueOnce(cloudOk("First reply."));
    render(<Sheet />);
    await screen.findByText("First reply.");
    gateway.mockReturnValueOnce(d.promise);
    const another = screen.getAllByText("Another")[0];
    fireEvent.click(another); fireEvent.click(another); fireEvent.click(another);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(gateway).toHaveBeenCalledTimes(2);
    await act(async () => { d.resolve(cloudOk("Second reply.")); });
    await screen.findByText("Second reply.");
  });

  it("switching to a different message never shows the previous message's late result", async () => {
    const d1 = deferred<unknown>();
    gateway.mockReturnValueOnce(d1.promise).mockResolvedValueOnce(cloudOk("Reply for message TWO."));
    const { rerender } = render(<Sheet partnerText="First message text" messageId="m1" />);
    await waitFor(() => expect(gateway).toHaveBeenCalledTimes(1));
    rerender(<Sheet partnerText="Second message text" messageId="m2" />);
    await screen.findByText("Reply for message TWO.");
    await act(async () => { d1.resolve(cloudOk("Late reply for message ONE.")); });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByText("Late reply for message ONE.")).toBeNull();
    expect(screen.getByText("Reply for message TWO.")).toBeTruthy();
  });

  it("closing the sheet while in flight ignores the late result; reopening shares the in-flight call (no second charge)", async () => {
    const d = deferred<unknown>();
    gateway.mockReturnValueOnce(d.promise);
    const onUse = vi.fn();
    const { rerender } = render(<Sheet onUse={onUse} />);
    await waitFor(() => expect(gateway).toHaveBeenCalledTimes(1));
    rerender(<Sheet open={false} onUse={onUse} />);
    rerender(<Sheet open onUse={onUse} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(gateway).toHaveBeenCalledTimes(1); // same identical request still in flight → shared
    await act(async () => { d.resolve(cloudOk("Shared reply.")); });
    await screen.findByText("Shared reply.");
    expect(onUse).not.toHaveBeenCalled(); // nothing auto-used / sent
  });

  it("provider failure → on-device reply, honestly labelled; never presented as AI-written", async () => {
    gateway.mockResolvedValue({ ok: false, code: "PROVIDER_FAILED", message: "x", fallback: "DETERMINISTIC" });
    render(<Sheet />);
    await screen.findByText("On-device reply here.");
    expect(screen.getByText("Suggested on your phone")).toBeTruthy();
    expect(screen.queryByText("Written by an AI service")).toBeNull();
  });

  it("no cloud consent → NO gateway call, on-device reply, opt-in offered; declining does not grant", async () => {
    consents.cloud = false;
    render(<Sheet />);
    await screen.findByText("On-device reply here.");
    expect(gateway).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByText("Not now"));
    expect(screen.queryByText("Allow AI service")).toBeNull();
    expect(gateway).not.toHaveBeenCalled();
  });

  it("if the on-device model already produced (and was charged for) the reply, the cloud is NOT also called", async () => {
    supportResponse.mockResolvedValue(local("Model-worded on-device reply.", true));
    render(<Sheet />);
    await screen.findByText("Model-worded on-device reply.");
    expect(gateway).not.toHaveBeenCalled();
    expect(consumeAiQuota).toHaveBeenCalledTimes(1);
  });

  it("'Use this reply' only hands text back to the composer", async () => {
    gateway.mockResolvedValue(cloudOk("Draft only."));
    const onUse = vi.fn();
    render(<Sheet onUse={onUse} />);
    await screen.findByText("Draft only.");
    expect(onUse).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Use this reply"));
    expect(onUse).toHaveBeenCalledWith("Draft only.");
  });
});

/**
 * UI-level checks for the chat-first relationship AI (jsdom; not a device).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { readFileSync } from "node:fs";

const hasConsent = vi.fn(async (..._a: unknown[]) => true);
const grant = vi.fn(async (..._a: unknown[]) => {});
const supportResponse = vi.fn((..._a: unknown[]) => Promise.resolve({} as unknown));
vi.mock("@/lib/relationship/production", () => ({ buildProductionRelationshipDeps: () => ({ gate: { hasConsent }, backend: { get: vi.fn(async () => null), set: vi.fn(async () => {}) } }) }));
vi.mock("@/lib/privacy/consent", () => ({ grantConsent: (...a: unknown[]) => grant(...a) }));
vi.mock("@/lib/relationship/service", () => ({ createRelationshipAIService: () => ({ supportResponse: (...a: unknown[]) => supportResponse(...a) }) }));
// vaul Drawer needs no real DOM measuring in jsdom for these checks
vi.mock("@/components/ui/drawer", () => ({
  Drawer: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DrawerDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));

import MessageContextMenu from "@/components/chat/MessageContextMenu";
import QuickReplySheet from "@/components/chat/QuickReplySheet";
import UnderstandSheet from "@/components/chat/UnderstandSheet";

const ready = (possibleResponse: string) => ({ support: { possibleResponse, safetyHold: false, refusal: null, insufficientInformation: false, notes: [], clarifyingQuestion: "?", limitedMode: false } });

beforeEach(() => { supportResponse.mockReset(); hasConsent.mockReset(); hasConsent.mockResolvedValue(true); grant.mockReset(); });

describe("long-press menu", () => {
  // Real MessageContextMenu API (verified): isOpen, onClose, onCopy, onDelete, onReply, isMine, messageContent, messageType, onHelpReply?, onUnderstand?
  const base = { isOpen: true, onClose: vi.fn(), onCopy: vi.fn(), onReply: vi.fn(), onDelete: vi.fn(), messageType: "text" };
  it("partner text message shows Help me reply and Understand", () => {
    render(<MessageContextMenu {...base} isMine={false} messageContent="Can you call me?" onHelpReply={vi.fn()} onUnderstand={vi.fn()} />);
    expect(screen.getByText("Help me reply")).toBeTruthy();
    expect(screen.getByText("Understand")).toBeTruthy();
  });
  it("my own message does not", () => {
    render(<MessageContextMenu {...base} isMine messageContent="hi" onHelpReply={vi.fn()} onUnderstand={vi.fn()} />);
    expect(screen.queryByText("Help me reply")).toBeNull();
    expect(screen.queryByText("Understand")).toBeNull();
  });
});

describe("Help me reply", () => {
  it("grounded intents appear; 'Use this reply' only hands the text back (never sends)", async () => {
    supportResponse.mockResolvedValue(ready("I hear you. You'd like me to call you. What time works?"));
    const onUse = vi.fn();
    render(<MemoryRouter><QuickReplySheet open userId="u" partnerText="I felt hurt. Can you call me tonight?" messageId="m1" onUse={onUse} onClose={vi.fn()} /></MemoryRouter>);
    await screen.findByText(/What time works/);
    expect(screen.getByText("Acknowledge")).toBeTruthy();
    expect(screen.getByText("Respond to their ask")).toBeTruthy();
    for (const chip of ["Another", "Shorter", "More casual", "Ask first"]) expect(screen.getAllByText(chip).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("Use this reply"));
    expect(onUse).toHaveBeenCalledWith("I hear you. You'd like me to call you. What time works?");
  });
  it("vague message → honest fallback, only a clarifying option", async () => {
    supportResponse.mockResolvedValue(ready("Do you want to talk about it, or would you rather have some space for now?"));
    render(<MemoryRouter><QuickReplySheet open userId="u" partnerText="whatever" messageId="m2" onUse={vi.fn()} onClose={vi.fn()} /></MemoryRouter>);
    await screen.findByText(/can't reliably tell what they mean/);
    expect(screen.queryByText("Acknowledge")).toBeNull();
  });
  it("consent denied → no processing, one-tap allow", async () => {
    supportResponse.mockRejectedValue(Object.assign(new Error("x"), { code: "CONSENT_MISSING" }));
    render(<MemoryRouter><QuickReplySheet open userId="u" partnerText="Can you call me?" messageId="m3" onUse={vi.fn()} onClose={vi.fn()} /></MemoryRouter>);
    await screen.findByText("Allow on-device help");
    expect(screen.queryByText("Respond to their ask")).toBeNull();
  });
});

describe("Understand", () => {
  it("one grounded statement, Why? reveals the exact words", async () => {
    render(<MemoryRouter><UnderstandSheet open userId="u" messageId="m1" text="Can you just tell me next time?" onHelpReply={vi.fn()} onClose={vi.fn()} /></MemoryRouter>);
    await screen.findByText(/They asked: “Can you just tell me next time\?”/);
    fireEvent.click(screen.getByText("Why?"));
    // exact evidence + the provenance line are shown
    expect(screen.getByText(/“Can you just tell me next time\?” — Based only on what they explicitly said\./)).toBeTruthy();
    fireEvent.click(screen.getByText("Hide"));
    expect(screen.queryByText(/Based only on what they explicitly said/)).toBeNull();
    expect(screen.getByText("Help me reply")).toBeTruthy();
  });
  it("unclear message → the one action is 'Ask them' (no invented meaning)", async () => {
    render(<MemoryRouter><UnderstandSheet open userId="u" messageId="m5" text="Maybe." onHelpReply={vi.fn()} onClose={vi.fn()} /></MemoryRouter>);
    await screen.findByText("Ask them");
    expect(screen.queryByText("Help me reply")).toBeNull();
    expect(screen.queryByText("Why?")).toBeNull();
  });
  it("vague → can't tell; nothing about feelings", async () => {
    render(<MemoryRouter><UnderstandSheet open userId="u" messageId="m2" text="fine." onHelpReply={vi.fn()} onClose={vi.fn()} /></MemoryRouter>);
    await screen.findByText(/can't reliably tell/i);
    expect(document.body.textContent).not.toMatch(/angry|upset|annoyed|hurt/i);
  });
  it("without consent the message is not analysed", async () => {
    hasConsent.mockResolvedValue(false);
    render(<MemoryRouter><UnderstandSheet open userId="u" messageId="m3" text="Can you call me?" onHelpReply={vi.fn()} onClose={vi.fn()} /></MemoryRouter>);
    await screen.findByText("Allow on-device help");
    expect(screen.queryByText(/They asked/)).toBeNull();
  });
  it("blame/event message offers lightweight repair entries", async () => {
    render(<MemoryRouter><UnderstandSheet open userId="u" messageId="m4" text="You cancelled dinner again." onHelpReply={vi.fn()} onClose={vi.fn()} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("Own my part")).toBeTruthy());
    expect(screen.getByText("Set a boundary")).toBeTruthy();
    expect(screen.getByText("Walk me through it")).toBeTruthy();
  });
});

describe("static guarantees", () => {
  it("no automatic sending anywhere in the new surfaces", () => {
    for (const f of ["src/components/chat/QuickReplySheet.tsx", "src/components/chat/UnderstandSheet.tsx", "src/components/relationship/TodayInsight.tsx"]) {
      const s = readFileSync(f, "utf8");
      expect(s, f).not.toMatch(/sendMessage|\.insert\(|from\(["']messages["']\)/);
    }
  });
  it("Today stores only dismissed message ids — never message text", () => {
    const s = readFileSync("src/components/relationship/TodayInsight.tsx", "utf8");
    const sets = [...s.matchAll(/backend\.set\(([^;]+)\)/g)].map((m) => m[1]);
    expect(sets.length).toBe(1);
    expect(sets[0]).toMatch(/ids:/);
    expect(sets[0]).not.toMatch(/decryptedContent|text|phrase|statement/);
  });
  it("advanced tools remain reachable behind More tools", () => {
    const s = readFileSync("src/pages/Reflection.tsx", "utf8");
    expect(s).toMatch(/<PartnerComparison/);
    expect(s).toMatch(/<InsightsTab/);
    expect(s).toMatch(/<DailyCheckIn/);
    expect(readFileSync("src/components/relationship/PartnerComparison.tsx", "utf8")).toMatch(/<RepairPanel[\s\S]*initial=|<MemoryPanel|ResponseSupportPanel/);
  });
});

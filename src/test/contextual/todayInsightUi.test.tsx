import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const page = { messages: [] as unknown[] };
const sets: unknown[] = [];
vi.mock("@/lib/chatCache", () => ({ readLocalChatPage: vi.fn(async () => page) }));
vi.mock("@/lib/relationship/production", () => ({ buildProductionRelationshipDeps: () => ({
  gate: { hasConsent: async () => true },
  backend: { get: async () => null, set: async (...a: unknown[]) => { sets.push(a); } },
}) }));
vi.mock("@/lib/privacy/consent", () => ({ grantConsent: vi.fn() }));
vi.mock("@/components/chat/QuickReplySheet", () => ({ default: () => null }));

import TodayInsight from "@/components/relationship/TodayInsight";
const now = new Date();
const msg = (id: string, text: string, minsAgo: number, sender = "P") => ({ id, sender_id: sender, created_at: new Date(now.getTime() - minsAgo * 60_000).toISOString(), message_type: "text", decryptedContent: text });

beforeEach(() => { page.messages = []; sets.length = 0; });

describe("Today card", () => {
  it("no useful signal → the honest empty state", async () => {
    page.messages = [msg("1", "ok", 5), msg("2", "😂", 3)];
    render(<MemoryRouter><TodayInsight userId="ME" partnerId="P" /></MemoryRouter>);
    expect(await screen.findByText("Nothing needs decoding today.")).toBeTruthy();
  });
  it("explicit request → one grounded notice with Why? and Help me reply", async () => {
    page.messages = [msg("1", "I felt tired today.", 30), msg("2", "Can you tell me earlier when your plans change?", 10)];
    render(<MemoryRouter><TodayInsight userId="ME" partnerId="P" /></MemoryRouter>);
    expect(await screen.findByText("They asked you: “Can you tell me earlier when your plans change?”")).toBeTruthy();
    expect(screen.getByText("A small thing worth noticing")).toBeTruthy();
    fireEvent.click(screen.getByText("Why?"));
    expect(screen.getByText(/Based only on what they explicitly said/)).toBeTruthy();
    expect(screen.getByText("Help me reply")).toBeTruthy();
  });
  it("dismiss stores only the message id, never text", async () => {
    page.messages = [msg("m-9", "Can you call me tonight after work?", 10)];
    render(<MemoryRouter><TodayInsight userId="ME" partnerId="P" /></MemoryRouter>);
    fireEvent.click(await screen.findByText("Dismiss"));
    await vi.waitFor(() => expect(sets.length).toBe(1));
    expect(JSON.stringify(sets[0])).toContain("m-9");
    expect(JSON.stringify(sets[0])).not.toMatch(/call me|tonight/i);
  });
});

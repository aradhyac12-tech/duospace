import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MediaStats } from "@/lib/nativeMediaStore";

vi.mock("@/lib/haptics", () => ({ hapticSelection: vi.fn(), hapticSuccess: vi.fn(), hapticHeavy: vi.fn() }));
const wipe = vi.fn(async () => {});
let stats: MediaStats;
vi.mock("@/lib/mediaCache", () => ({
  getMediaCacheStats: async () => stats,
  wipeMediaCache: () => wipe(),
}));

import StorageCard from "@/components/settings/StorageCard";
import { formatBytes } from "@/lib/formatBytes";

const mk = (over: Partial<MediaStats> = {}): MediaStats => ({
  count: 5, size: 3 * 1024 * 1024,
  photos: { count: 3, size: 2 * 1024 * 1024 }, audio: { count: 2, size: 1024 * 1024 },
  video: { count: 0, size: 0 }, other: { count: 0, size: 0 }, ...over,
});

describe("formatBytes", () => {
  it("formats sensibly", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(formatBytes(250 * 1024 * 1024)).toBe("250 MB");
  });
});

describe("StorageCard", () => {
  beforeEach(() => { localStorage.clear(); wipe.mockClear(); stats = mk(); });

  it("shows the total and only the kinds that exist", async () => {
    render(<StorageCard />);
    await waitFor(() => expect(screen.getByTestId("storage-total")).toHaveTextContent("3.0 MB"));
    expect(screen.getByText(/Photos · 3/)).toBeInTheDocument();
    expect(screen.getByText(/Voice notes · 2/)).toBeInTheDocument();
    expect(screen.queryByText(/Videos/)).not.toBeInTheDocument();
  });

  it("Wi-Fi-only switch persists the choice", async () => {
    render(<StorageCard />);
    const sw = screen.getByRole("switch", { name: /Wi-Fi only/i });
    expect(sw).toHaveAttribute("aria-checked", "false");
    await userEvent.click(sw);
    expect(localStorage.getItem("duo-offline-wifi-only-media")).toBe("1");
    expect(sw).toHaveAttribute("aria-checked", "true");
    await userEvent.click(sw);
    expect(localStorage.getItem("duo-offline-wifi-only-media")).toBeNull();
  });

  it("clearing needs a confirm, then wipes media and refreshes", async () => {
    render(<StorageCard />);
    await waitFor(() => expect(screen.getByTestId("storage-total")).toHaveTextContent("3.0 MB"));
    await userEvent.click(screen.getByRole("button", { name: /Clear downloaded media/i }));
    expect(wipe).not.toHaveBeenCalled();                 // dialog first
    stats = mk({ count: 0, size: 0, photos: { count: 0, size: 0 }, audio: { count: 0, size: 0 } });
    await userEvent.click(await screen.findByRole("button", { name: "Clear media" }));
    await waitFor(() => expect(wipe).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("storage-total")).toHaveTextContent("0 B"));
  });

  it("the clear button is disabled when nothing is stored", async () => {
    stats = mk({ count: 0, size: 0 });
    render(<StorageCard />);
    await waitFor(() => expect(screen.getByTestId("storage-total")).toHaveTextContent("0 B"));
    expect(screen.getByRole("button", { name: /Clear downloaded media/i })).toBeDisabled();
  });
});

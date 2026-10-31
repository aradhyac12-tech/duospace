import { describe, it, expect, vi, beforeEach } from "vitest";
const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: toastError } }));

describe("library/playlist saves are no longer silent on quota failure", () => {
  beforeEach(() => { toastError.mockClear(); vi.resetModules(); });
  it("playlists: toasts when localStorage.setItem throws", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
    const { createPlaylist } = await import("@/lib/music/playlists");
    createPlaylist("Road trip");
    expect(toastError).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

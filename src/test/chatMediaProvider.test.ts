// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

const cloud = vi.fn(); const legacy = vi.fn();
vi.mock("@/services/media/cloudinary", () => ({ uploadToCloudinary: (...a: unknown[]) => cloud(...a) }));
vi.mock("@/services/media/legacySupabaseMedia", () => ({ uploadLegacyChatFile: (...a: unknown[]) => legacy(...a) }));
vi.mock("@/lib/telemetry", () => ({ logWarn: vi.fn() }));

import { shouldUseCloudinaryForChat, uploadChatMedia } from "@/services/media/chatMediaProvider";
import { MediaError } from "@/services/media/types";

const base = { userId: "u1", clientId: "pending-11111111-1111-4111-8111-111111111111", fileName: "a.jpg", file: new Blob(["x"]), disappearAt: null as unknown };
beforeEach(() => { cloud.mockReset(); legacy.mockReset(); legacy.mockResolvedValue({ pseudoPublicUrl: "https://s/chat-files/u1/x", path: "u1/x" }); });

describe("flag OFF = existing behaviour", () => {
  it("always uses the legacy path with the historical object path", async () => {
    const r = await uploadChatMedia({ ...base, msgType: "image" }, false);
    expect(cloud).not.toHaveBeenCalled();
    expect(legacy).toHaveBeenCalledWith(expect.objectContaining({ objectPath: "u1/11111111-1111-4111-8111-111111111111_a.jpg" }));
    expect(r.mediaAssetId).toBeUndefined();
  });
});

describe("flag ON = Cloudinary provider", () => {
  it("routes photos and videos to Cloudinary, keyed by the stable client id (retry-safe)", async () => {
    cloud.mockResolvedValue({ ref: "media:m1", mediaId: "m1" });
    const r = await uploadChatMedia({ ...base, msgType: "video" }, true);
    expect(legacy).not.toHaveBeenCalled();
    expect(cloud).toHaveBeenCalledWith(base.file, expect.objectContaining({ scope: "chat", clientUploadId: "11111111-1111-4111-8111-111111111111" }));
    expect(r).toEqual({ pseudoPublicUrl: "media:m1", path: "media:m1", mediaAssetId: "m1" });
  });
  it("keeps voice notes and generic files on the legacy path", async () => {
    for (const t of ["voice", "file", "audio"]) await uploadChatMedia({ ...base, msgType: t }, true);
    expect(cloud).not.toHaveBeenCalled(); expect(legacy).toHaveBeenCalledTimes(3);
  });
  it("keeps disappearing/vanish messages on the legacy path (their purge only knows Supabase objects)", async () => {
    expect(shouldUseCloudinaryForChat("image", "vanish", true)).toBe(false);
    expect(shouldUseCloudinaryForChat("image", new Date().toISOString(), true)).toBe(false);
    expect(shouldUseCloudinaryForChat("image", null, true)).toBe(true);
  });
  it("falls back to legacy only when Cloudinary is not configured (nothing was uploaded)", async () => {
    cloud.mockRejectedValue(new MediaError("NOT_CONFIGURED", "x"));
    await uploadChatMedia({ ...base, msgType: "image" }, true);
    expect(legacy).toHaveBeenCalledTimes(1);
  });
  it("does NOT silently fall back on other failures — the send queue sees the error and retries/fails as before", async () => {
    cloud.mockRejectedValue(new MediaError("NETWORK", "net", undefined, true));
    await expect(uploadChatMedia({ ...base, msgType: "image" }, true)).rejects.toMatchObject({ code: "NETWORK" });
    expect(legacy).not.toHaveBeenCalled();
  });
});

// @vitest-environment node
import { describe, it, expect } from "vitest";
import { sniffMime, validateMediaFile } from "@/services/media/validation";
import { MEDIA_LIMITS } from "@/services/media/config";
import { MediaError } from "@/services/media/types";

const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(40).fill(0)]);
const ftyp = (brand: string) => bytes(0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, ...[...brand].map((c) => c.charCodeAt(0)));
const blob = (u8: Uint8Array, type = "") => new Blob([u8], { type });

describe("sniffMime (magic bytes, not extension)", () => {
  it("detects common formats", () => {
    expect(sniffMime(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffMime(bytes(0x89, 0x50, 0x4e, 0x47))).toBe("image/png");
    expect(sniffMime(ftyp("heic"))).toBe("image/heic");
    expect(sniffMime(ftyp("isom"))).toBe("video/mp4");
    expect(sniffMime(ftyp("qt  "))).toBe("video/quicktime");
    expect(sniffMime(bytes(0x1a, 0x45, 0xdf, 0xa3))).toBe("video/webm");
    expect(sniffMime(bytes(1, 2, 3, 4))).toBeNull();
  });
});

describe("validateMediaFile", () => {
  it("accepts a real JPEG even when the browser reports no type (Android)", async () => {
    expect(await validateMediaFile(blob(bytes(0xff, 0xd8, 0xff), ""), "gallery")).toEqual({ mime: "image/jpeg", kind: "image" });
  });
  it("rejects arbitrary bytes labelled image/jpeg", async () => {
    await expect(validateMediaFile(blob(bytes(1, 2, 3, 4), "image/jpeg"), "gallery")).rejects.toMatchObject({ code: "INVALID_FILE" });
  });
  it("rejects a video disguised as an image", async () => {
    await expect(validateMediaFile(blob(ftyp("isom"), "image/jpeg"), "gallery")).rejects.toBeInstanceOf(MediaError);
  });
  it("rejects empty files", async () => {
    await expect(validateMediaFile(new Blob([]), "gallery")).rejects.toMatchObject({ code: "INVALID_FILE" });
  });
  it("rejects oversized images", async () => {
    const big = { size: MEDIA_LIMITS.maxImageBytes + 1, type: "image/jpeg", slice: () => ({ arrayBuffer: async () => bytes(0xff, 0xd8, 0xff).buffer }) } as unknown as Blob;
    await expect(validateMediaFile(big, "gallery")).rejects.toMatchObject({ code: "INVALID_FILE", message: expect.stringContaining("too large") });
  });
  it("keeps profile/memories image-only", async () => {
    await expect(validateMediaFile(blob(ftyp("isom"), "video/mp4"), "memories")).rejects.toMatchObject({ code: "INVALID_FILE" });
    await expect(validateMediaFile(blob(ftyp("isom"), "video/mp4"), "profile")).rejects.toMatchObject({ code: "INVALID_FILE" });
  });
  it("allows videos in chat and gallery (duration unknown in node = not blocked client-side; server enforces)", async () => {
    expect(await validateMediaFile(blob(ftyp("isom"), "video/mp4"), "chat")).toEqual({ mime: "video/mp4", kind: "video" });
  });
});

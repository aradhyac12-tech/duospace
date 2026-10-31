import { describe, it, expect } from "vitest";
import { getThumb, peekThumb, hasNoThumb } from "@/lib/photoThumbs";

describe("photoThumbs", () => {
  it("falls back to the original when the browser can't thumbnail (no createImageBitmap)", async () => {
    const saved = (globalThis as any).createImageBitmap;
    (globalThis as any).createImageBitmap = undefined;
    try {
      expect(await getThumb("m1", "blob:nothing")).toBeNull();
      expect(hasNoThumb("m1")).toBe(true);
      expect(peekThumb("m1")).toBeNull();
    } finally {
      (globalThis as any).createImageBitmap = saved;
    }
  });
});

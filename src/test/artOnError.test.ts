import { describe, it, expect } from "vitest";
import { onArtError } from "@/lib/music/artOnError";
import { fallbackArt } from "@/lib/music/fallbackArt";

const fakeEvent = (src: string) => {
  const el = { src, dataset: {} as Record<string, string> };
  return { el, evt: { currentTarget: el } as never };
};

describe("onArtError", () => {
  it("swaps a broken cover for the generated fallback exactly once (no error loop)", () => {
    const { el, evt } = fakeEvent("https://broken.example/a.jpg");
    const h = onArtError("Song", "Artist");
    h(evt);
    expect(el.src).toBe(fallbackArt("Song", "Artist"));
    el.src = "https://again.example/b.jpg"; // a second error must not overwrite again
    h(evt);
    expect(el.src).toBe("https://again.example/b.jpg");
  });
});

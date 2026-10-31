import { describe, it, expect } from "vitest";
import { parseLrc, activeLineIndex, cleanTrackQuery, pickBestMatch } from "@/lib/music/lyrics";

describe("lyrics helpers", () => {
  it("parses LRC with multi-stamps, skips metadata and blanks", () => {
    const l = parseLrc("[ar:X]\n[00:10.50]Hello\n[00:05.5][01:00.123]World\n[00:20.00]\n");
    expect(l.map((x) => x.t)).toEqual([5.5, 10.5, 60.123]);
  });
  it("finds the active line", () => {
    const l = parseLrc("[00:05.00]a\n[00:10.00]b");
    expect(activeLineIndex(l, 0)).toBe(-1);
    expect(activeLineIndex(l, 6)).toBe(0);
    expect(activeLineIndex(l, 99)).toBe(1);
  });
  it("cleans YouTube-style titles", () => {
    const q = cleanTrackQuery({ title: "Bruno Mars - Locked Out Of Heaven (Official Video) | HD", artist: "BrunoMarsVEVO", provider: "youtube" } as any);
    expect(q).toMatchObject({ title: "Locked Out Of Heaven", artist: "Bruno Mars" });
  });
  it("rejects a synced match whose length is far off", () => {
    const r = pickBestMatch([{ duration: 200, plainLyrics: "a" }, { duration: 230, syncedLyrics: "[00:01.00]x" }], 200);
    expect(r?.plainLyrics).toBe("a");
  });
});

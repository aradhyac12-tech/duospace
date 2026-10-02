import { describe, it, expect, beforeEach } from "vitest";
import {
  recordPlayed, recordSkipped, recordCompleted, readPlayLog, getRecentlyPlayedKeys,
  setMusicProfileScope, mergePlayLogs, importMusicProfile,
} from "@/lib/music/playHistory";
import { buildTaste } from "@/lib/music/autoNext";

describe("per-account music profile", () => {
  beforeEach(() => { localStorage.clear(); setMusicProfileScope(null); });

  it("keeps each account's taste separate", () => {
    setMusicProfileScope("user-a");
    recordPlayed("Song A", "Artist A");
    setMusicProfileScope("user-b");
    expect(readPlayLog()).toHaveLength(0);
    expect(getRecentlyPlayedKeys().size).toBe(0);
    recordPlayed("Song B", "Artist B");
    setMusicProfileScope("user-a");
    expect(readPlayLog().map((e) => e.artist)).toEqual(["Artist A"]);
  });

  it("adopts legacy global data once, for the first account only", () => {
    localStorage.setItem("groic-play-log", JSON.stringify([{ key: "old", artist: "Old", at: 1 }]));
    setMusicProfileScope("user-a");
    expect(readPlayLog()).toHaveLength(1);
    setMusicProfileScope("user-b");
    expect(readPlayLog()).toHaveLength(0);
    expect(localStorage.getItem("groic-play-log")).toBeNull();
  });

  it("records non-Latin titles instead of dropping them", () => {
    setMusicProfileScope("user-a");
    recordPlayed("तेरी मेरी", "Arijit");
    expect(getRecentlyPlayedKeys().size).toBe(1);
  });

  it("completion counts for the artist, a skip counts against", () => {
    setMusicProfileScope("user-a");
    recordPlayed("Song A", "Artist A"); recordCompleted("Song A");
    recordPlayed("Song B", "Artist B"); recordSkipped("Song B", "Artist B");
    const taste = buildTaste(readPlayLog());
    expect(taste.map((t) => t.name)).toEqual(["Artist A"]);
    expect(taste[0].score).toBeGreaterThan(1.4);
  });

  it("merges a remote profile without duplicating events", () => {
    setMusicProfileScope("user-a");
    recordPlayed("Song A", "Artist A");
    const local = readPlayLog();
    const merged = importMusicProfile({ playLog: [...local, { key: "song b", artist: "B", at: 5 }], playHistory: ["song b"] });
    expect(merged.playLog).toHaveLength(2);
    expect(mergePlayLogs(local, local)).toHaveLength(1);
    expect(getRecentlyPlayedKeys().has("song b")).toBe(true);
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { recordPlayed, getRecentlyPlayedKeys } from "@/lib/music/playHistory";
import { songKey } from "@/lib/music/queueQuality";

describe("playHistory", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("records a played title as its normalized song key", () => {
    recordPlayed("Bad Guy (Official Video)");
    expect(getRecentlyPlayedKeys().has(songKey("Bad Guy"))).toBe(true);
  });

  it("does not duplicate an entry when the same song is played again", () => {
    recordPlayed("Song A");
    recordPlayed("Song A (Remix)"); // same songKey
    recordPlayed("Song B");
    expect(getRecentlyPlayedKeys().size).toBe(2);
  });

  it("caps the history window so it doesn't grow unbounded", () => {
    for (let i = 0; i < 60; i++) recordPlayed(`Song ${i}`);
    expect(getRecentlyPlayedKeys().size).toBeLessThanOrEqual(40);
  });

  it("keeps the most recently played song even after the cap is exceeded", () => {
    for (let i = 0; i < 45; i++) recordPlayed(`Song ${i}`);
    expect(getRecentlyPlayedKeys().has(songKey("Song 44"))).toBe(true); // most recent survives
    expect(getRecentlyPlayedKeys().has(songKey("Song 0"))).toBe(false); // oldest evicted
  });
});

import { describe, it, expect } from "vitest";
import { findNativeTwin, buildTwinQuery } from "@/lib/music/nativeTwin";
import type { GroicTrack } from "@/lib/music/types";

const mk = (over: Partial<GroicTrack> & { title: string }): GroicTrack => ({
  id: `soundcloud:${over.title}`, provider: "soundcloud", providerTrackId: over.title, videoId: over.title,
  artist: "Artist", thumbnail: null, duration: 200, isStreamable: true, ...over,
});
const yt = mk({ id: "youtube:1", provider: "youtube", title: "Bad Guy (Official Video)", artist: "Billie Eilish - Topic", duration: 194 });

describe("findNativeTwin", () => {
  it("matches the same song by title+artist+duration", () => {
    const t = mk({ title: "Bad Guy", artist: "Billie Eilish", duration: 196 });
    expect(findNativeTwin(yt, [t])?.id).toBe(t.id);
  });
  it("rejects a different duration (e.g. a 10-minute loop)", () => {
    expect(findNativeTwin(yt, [mk({ title: "Bad Guy", artist: "Billie Eilish", duration: 600 })])).toBeNull();
  });
  it("never matches two different non-Latin titles", () => {
    const hi = mk({ id: "youtube:2", provider: "youtube", title: "तेरी मेरी", artist: "A", duration: 200 });
    expect(findNativeTwin(hi, [mk({ title: "कुछ और", artist: "A", duration: 200 })])).toBeNull();
  });
  it("matches identical non-Latin titles", () => {
    const hi = mk({ id: "youtube:2", provider: "youtube", title: "तेरी मेरी", artist: "A", duration: 200 });
    const t = mk({ title: "तेरी मेरी", artist: "A", duration: 201 });
    expect(findNativeTwin(hi, [t])?.id).toBe(t.id);
  });
  it("needs artist overlap unless the duration is very tight", () => {
    const other = mk({ title: "Bad Guy", artist: "Someone Else", duration: 180 });
    expect(findNativeTwin(yt, [other])).toBeNull();
    const tight = mk({ title: "Bad Guy", artist: "Someone Else", duration: 195 });
    expect(findNativeTwin(yt, [tight])?.id).toBe(tight.id);
  });
  it("prefers the closest duration", () => {
    const a = mk({ title: "Bad Guy", artist: "Billie Eilish", duration: 210 });
    const b = mk({ id: "audius:b", provider: "audius", title: "Bad Guy", artist: "Billie Eilish", duration: 195 });
    expect(findNativeTwin(yt, [a, b])?.id).toBe("audius:b");
  });
  it("ignores non-native and unstreamable candidates", () => {
    expect(findNativeTwin(yt, [mk({ id: "youtube:9", provider: "youtube", title: "Bad Guy", artist: "Billie Eilish" })])).toBeNull();
    expect(findNativeTwin(yt, [mk({ title: "Bad Guy", artist: "Billie Eilish", isStreamable: false })])).toBeNull();
  });
  it("builds a query without video noise", () => {
    expect(buildTwinQuery(yt)).toBe("Bad Guy billie eilish");
  });
});

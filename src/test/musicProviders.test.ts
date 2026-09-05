import { describe, it, expect, vi, beforeEach } from "vitest";
import { isNativelyStreamable, makeTrackId } from "@/lib/music/types";
import { youtubeResultToTrack } from "@/lib/music/youtubeProvider";

// Mock at the edgeFunction boundary rather than deeper (fetch/Supabase) —
// audiusProvider.ts's own job is normalizing what invokeEdgeFunction
// returns, so that's the right seam to fake for these tests, matching
// this test suite's existing pattern of mocking the client library
// boundary (see setup.ts's supabase client mock).
const invokeEdgeFunctionMock = vi.fn();
vi.mock("@/lib/edgeFunction", () => ({
  invokeEdgeFunction: (...args: unknown[]) => invokeEdgeFunctionMock(...args),
}));

// Imported after the mock is registered so audiusProvider.ts/
// soundcloudProvider.ts pick up the mocked invokeEdgeFunction rather than
// the real implementation.
const { searchAudius, trendingAudius, resolveAudiusStreamUrl } = await import("@/lib/music/audiusProvider");
const { searchSoundCloud, resolveSoundCloudStreamUrl } = await import("@/lib/music/soundcloudProvider");

beforeEach(() => {
  invokeEdgeFunctionMock.mockReset();
});

describe("types.ts — provider helpers", () => {
  it("makeTrackId is stable and provider-qualified", () => {
    expect(makeTrackId("audius", "abc123")).toBe("audius:abc123");
    expect(makeTrackId("youtube", "abc123")).toBe("youtube:abc123");
    // Same providerTrackId, different provider -> different overall id —
    // this is exactly what prevents an Audius/YouTube id collision.
    expect(makeTrackId("audius", "abc123")).not.toBe(makeTrackId("youtube", "abc123"));
  });

  it("isNativelyStreamable is true for Audius/SoundCloud tracks not explicitly marked unstreamable", () => {
    expect(isNativelyStreamable({ provider: "audius", isStreamable: true })).toBe(true);
    expect(isNativelyStreamable({ provider: "audius", isStreamable: undefined })).toBe(true); // missing = assume streamable
    expect(isNativelyStreamable({ provider: "audius", isStreamable: false })).toBe(false);
    expect(isNativelyStreamable({ provider: "soundcloud", isStreamable: true })).toBe(true);
    expect(isNativelyStreamable({ provider: "soundcloud", isStreamable: undefined })).toBe(true);
    expect(isNativelyStreamable({ provider: "soundcloud", isStreamable: false })).toBe(false);
    expect(isNativelyStreamable({ provider: "youtube", isStreamable: true })).toBe(false); // provider check wins regardless
    expect(isNativelyStreamable({ provider: "local", isStreamable: true })).toBe(false);
  });

  it("makeTrackId keeps soundcloud and audius ids from colliding", () => {
    expect(makeTrackId("soundcloud", "abc123")).toBe("soundcloud:abc123");
    expect(makeTrackId("soundcloud", "abc123")).not.toBe(makeTrackId("audius", "abc123"));
  });
});

describe("youtubeProvider.youtubeResultToTrack", () => {
  it("normalizes a YouTube search result and marks it not natively streamable", () => {
    const track = youtubeResultToTrack({
      title: "Bad Guy", artist: "Billie Eilish", videoId: "abc123",
      thumbnail: "https://example.com/thumb.jpg", duration: 194, url: "https://youtube.com/watch?v=abc123",
    });
    expect(track.provider).toBe("youtube");
    expect(track.providerTrackId).toBe("abc123");
    expect(track.videoId).toBe("abc123"); // back-compat field
    expect(track.id).toBe("youtube:abc123");
    expect(track.isStreamable).toBe(false); // never natively streamable — see file header
    expect(isNativelyStreamable(track)).toBe(false);
  });
});

describe("audiusProvider.searchAudius", () => {
  it("normalizes results into GroicTrack shape with a qualified id", async () => {
    invokeEdgeFunctionMock.mockResolvedValue({
      results: [{
        provider: "audius", providerTrackId: "xyz789", title: "Some Song", artist: "Some Artist",
        artwork: "https://example.com/art.jpg", duration: 210, permalink: "/some/song",
        isStreamable: true, isDownloadable: false,
      }],
    });
    const tracks = await searchAudius("some song");
    expect(tracks).toHaveLength(1);
    expect(tracks[0].id).toBe("audius:xyz789");
    expect(tracks[0].provider).toBe("audius");
    expect(tracks[0].videoId).toBe("xyz789"); // back-compat mirror
    expect(tracks[0].thumbnail).toBe("https://example.com/art.jpg");
    expect(invokeEdgeFunctionMock).toHaveBeenCalledWith("audius-search", { body: { mode: "search", query: "some song" } });
  });

  it("returns an empty array (not a throw) when the edge function reports no results", async () => {
    invokeEdgeFunctionMock.mockResolvedValue({ results: [] });
    const tracks = await searchAudius("nonexistent xyz");
    expect(tracks).toEqual([]);
  });
});

describe("audiusProvider.trendingAudius", () => {
  it("passes an optional genre through to the edge function", async () => {
    invokeEdgeFunctionMock.mockResolvedValue({ results: [] });
    await trendingAudius("Electronic");
    expect(invokeEdgeFunctionMock).toHaveBeenCalledWith("audius-search", { body: { mode: "trending", genre: "Electronic" } });
  });
});

describe("audiusProvider.resolveAudiusStreamUrl — graceful failure handling", () => {
  it("returns the resolved URL on success", async () => {
    invokeEdgeFunctionMock.mockResolvedValue({ streamUrl: "https://discoveryprovider.audius.co/v1/tracks/xyz/stream" });
    const url = await resolveAudiusStreamUrl("xyz");
    expect(url).toBe("https://discoveryprovider.audius.co/v1/tracks/xyz/stream");
  });

  it("returns null (never throws) when the track is unavailable", async () => {
    invokeEdgeFunctionMock.mockResolvedValue({ streamUrl: null, error: "Track unavailable" });
    const url = await resolveAudiusStreamUrl("gone");
    expect(url).toBeNull();
  });

  it("returns null (never throws) when the edge function itself fails/times out", async () => {
    invokeEdgeFunctionMock.mockRejectedValue(new Error("network timeout"));
    // This is the actual "provider timeout" / "provider failure" behavior
    // GroicContext.playTrack relies on — a rejected promise here would
    // otherwise propagate as an unhandled rejection instead of the
    // graceful "mark unavailable" the brief requires.
    await expect(resolveAudiusStreamUrl("whatever")).resolves.toBeNull();
  });
});

describe("soundcloudProvider.searchSoundCloud", () => {
  it("normalizes results into GroicTrack shape with a qualified id, never downloadable", async () => {
    invokeEdgeFunctionMock.mockResolvedValue({
      results: [{
        provider: "soundcloud", providerTrackId: "sc456", title: "Some Track", artist: "Some Uploader",
        artwork: "https://example.com/art-t500x500.jpg", duration: 180, permalink: "https://soundcloud.com/some/track",
        isStreamable: true,
      }],
    });
    const tracks = await searchSoundCloud("some track");
    expect(tracks).toHaveLength(1);
    expect(tracks[0].id).toBe("soundcloud:sc456");
    expect(tracks[0].provider).toBe("soundcloud");
    expect(tracks[0].videoId).toBe("sc456"); // back-compat mirror
    expect(tracks[0].isDownloadable).toBe(false); // never offline-downloadable — see offlineDownloads.ts's canDownload(), intentionally audius-only
    expect(isNativelyStreamable(tracks[0])).toBe(true);
    expect(invokeEdgeFunctionMock).toHaveBeenCalledWith("soundcloud-search", { body: { mode: "search", query: "some track" } });
  });

  it("returns an empty array (not a throw) when the edge function reports no results", async () => {
    invokeEdgeFunctionMock.mockResolvedValue({ results: [] });
    const tracks = await searchSoundCloud("nonexistent xyz");
    expect(tracks).toEqual([]);
  });
});

describe("soundcloudProvider.resolveSoundCloudStreamUrl — graceful failure handling", () => {
  it("returns the resolved URL on success", async () => {
    invokeEdgeFunctionMock.mockResolvedValue({ streamUrl: "https://cf-media.sndcdn.com/track.128.mp3?signature=abc" });
    const url = await resolveSoundCloudStreamUrl("sc456");
    expect(url).toBe("https://cf-media.sndcdn.com/track.128.mp3?signature=abc");
  });

  it("returns null (never throws) when the track is unavailable", async () => {
    invokeEdgeFunctionMock.mockResolvedValue({ streamUrl: null, error: "Track unavailable" });
    const url = await resolveSoundCloudStreamUrl("gone");
    expect(url).toBeNull();
  });

  it("returns null (never throws) when the edge function itself fails/times out", async () => {
    invokeEdgeFunctionMock.mockRejectedValue(new Error("network timeout"));
    // Same "provider timeout" contract resolveAudiusStreamUrl already
    // guarantees — GroicContext's resolveNativeStreamUrl dispatcher relies
    // on both resolvers never throwing.
    await expect(resolveSoundCloudStreamUrl("whatever")).resolves.toBeNull();
  });
});

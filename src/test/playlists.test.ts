import { describe, it, expect, beforeEach } from "vitest";
import { createPlaylist, addToPlaylist, removeFromPlaylist, renamePlaylist, deletePlaylist, readPlaylists, resolvePlaylistTracks } from "@/lib/music/playlists";
import type { GroicTrack } from "@/lib/music/types";

const track = (id: string, provider = "soundcloud"): GroicTrack =>
  ({ id: `${provider}:${id}`, provider, providerTrackId: id, videoId: id, title: `T${id}`, artist: "A", thumbnail: "data:image/jpeg;base64,AAAA", artwork: "x", duration: 100, isStreamable: true, isDownloadable: false } as unknown as GroicTrack);

describe("my playlists", () => {
  beforeEach(() => localStorage.clear());
  it("creates, dedupes, removes, renames, deletes", () => {
    expect(createPlaylist("   ")).toBeNull();
    const id = createPlaylist("  Night   drive ", track("1"))!;
    expect(readPlaylists()[0].name).toBe("Night drive");
    expect(addToPlaylist(id, track("1"))).toBe("duplicate");
    expect(addToPlaylist(id, track("2"))).toBe("added");
    removeFromPlaylist(id, "soundcloud:1");
    expect(readPlaylists()[0].tracks.map((t) => t.providerTrackId)).toEqual(["2"]);
    expect(renamePlaylist(id, "Chill")).toBe(true);
    expect(addToPlaylist("nope", track("3"))).toBe("missing");
    deletePlaylist(id);
    expect(readPlaylists()).toEqual([]);
  });
  it("does not persist local covers and resolves local songs from My Files", () => {
    const id = createPlaylist("Mine", track("L1", "local"))!;
    expect(readPlaylists()[0].tracks[0].thumbnail).toBeNull();
    const pl = readPlaylists()[0];
    expect(resolvePlaylistTracks(pl, new Map())).toHaveLength(0); // removed from My Files -> hidden
    const fresh = track("L1", "local");
    expect(resolvePlaylistTracks(pl, new Map([["L1", fresh]]))).toEqual([fresh]);
    expect(id).toBeTruthy();
  });
});

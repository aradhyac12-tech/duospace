import { describe, it, expect, beforeEach } from "vitest";
import { syncDeviceTracks, listLocalTracks, resolveLocalStreamUrl, type DeviceScanItem } from "@/lib/music/localLibrary";

const item = (id: string, title = `Song ${id}`): DeviceScanItem => ({ id, uri: `content://media/external/audio/media/${id}`, title, artist: "A", duration: 200 });

describe("syncDeviceTracks (Scan phone)", () => {
  beforeEach(() => { localStorage.clear(); });

  it("adds scanned songs once and does not duplicate on rescan", () => {
    expect(syncDeviceTracks([item("1"), item("2")])).toEqual({ added: 2, removed: 0 });
    expect(syncDeviceTracks([item("1"), item("2")])).toEqual({ added: 0, removed: 0 });
    expect(listLocalTracks()).toHaveLength(2);
  });
  it("drops scanned songs that disappeared from the phone", () => {
    syncDeviceTracks([item("1"), item("2")]);
    expect(syncDeviceTracks([item("2")])).toEqual({ added: 0, removed: 1 });
    expect(listLocalTracks().map((t) => t.providerTrackId)).toEqual(["ms2"]);
  });
  it("plays scanned songs straight from their content:// URI", async () => {
    syncDeviceTracks([item("7")]);
    expect(await resolveLocalStreamUrl("ms7")).toBe("content://media/external/audio/media/7");
  });
});

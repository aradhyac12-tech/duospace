import { describe, it, expect } from "vitest";
import { parseId3 } from "@/lib/music/id3";

const ss = (n: number) => [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
const text = (id: string, s: string) => {
  const body = [3, ...new TextEncoder().encode(s)]; // UTF-8
  return [...new TextEncoder().encode(id), ...ss(body.length), 0, 0, ...body];
};
const tag = (frames: number[][]) => {
  const body = frames.flat();
  return new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, ...ss(body.length), ...body]);
};

describe("parseId3", () => {
  it("reads title and artist (v2.4, UTF-8)", () => {
    expect(parseId3(tag([text("TIT2", "Tum Hi Ho"), text("TPE1", "Arijit Singh")]))).toMatchObject({ title: "Tum Hi Ho", artist: "Arijit Singh" });
  });
  it("prefers TPE1 over TPE2 for the artist", () => {
    expect(parseId3(tag([text("TPE2", "Various"), text("TPE1", "Real Artist")])).artist).toBe("Real Artist");
  });
  it("extracts an embedded cover", () => {
    const pic = [0, ...new TextEncoder().encode("image/png"), 0, 3, 0, 1, 2, 3, 4];
    const apic = [...new TextEncoder().encode("APIC"), ...ss(pic.length), 0, 0, ...pic];
    const r = parseId3(tag([apic]));
    expect(r.cover?.mime).toBe("image/png");
    expect([...(r.cover?.data ?? [])]).toEqual([1, 2, 3, 4]);
  });
  it("returns nothing for non-ID3 or garbage, never throws", () => {
    expect(parseId3(new Uint8Array([1, 2, 3]))).toEqual({});
    expect(parseId3(new Uint8Array(64))).toEqual({});
  });
});

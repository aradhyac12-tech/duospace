import { describe, it, expect } from "vitest";
import { parseMp4, parseFlac } from "@/lib/music/audioTags";
import { fallbackArt } from "@/lib/music/fallbackArt";

const enc = (s: string) => Array.from(new TextEncoder().encode(s));
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const box = (type: number[], payload: number[]) => [...u32(8 + payload.length), ...type, ...payload];
const A9 = (name: string) => [0xa9, ...enc(name)];
const dataBox = (flags: number, payload: number[]) => box(enc("data"), [...u32(flags), 0, 0, 0, 0, ...payload]);

describe("parseMp4 (M4A)", () => {
  it("reads title, artist and cover from iTunes atoms", () => {
    const ilst = box(enc("ilst"), [
      ...box(A9("nam"), dataBox(1, enc("Kesariya"))),
      ...box(A9("ART"), dataBox(1, enc("Arijit Singh"))),
      ...box(enc("covr"), dataBox(14, [9, 8, 7])),
    ]);
    const file = new Uint8Array([...box(enc("ftyp"), enc("M4A \0\0\0\0")), ...box(enc("moov"), box(enc("udta"), box(enc("meta"), [0, 0, 0, 0, ...ilst])))]);
    const r = parseMp4(file);
    expect(r.title).toBe("Kesariya");
    expect(r.artist).toBe("Arijit Singh");
    expect(r.cover?.mime).toBe("image/png");
    expect([...(r.cover?.data ?? [])]).toEqual([9, 8, 7]);
  });
  it("returns {} for garbage", () => { expect(parseMp4(new Uint8Array(40))).toEqual({}); });
});

describe("parseFlac", () => {
  it("reads Vorbis comments and the PICTURE block", () => {
    const comment = (kv: string) => [...le32(enc(kv).length), ...enc(kv)];
    const vc = [...le32(3), ...enc("lib"), ...le32(2), ...comment("TITLE=Heer"), ...comment("ARTIST=Jasleen")];
    const mime = enc("image/jpeg");
    const pic = [...u32(3), ...u32(mime.length), ...mime, ...u32(0), ...u32(1), ...u32(1), ...u32(24), ...u32(0), ...u32(3), 5, 6, 7];
    const blk = (type: number, last: boolean, body: number[]) => [(last ? 0x80 : 0) | type, (body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255, ...body];
    const file = new Uint8Array([...enc("fLaC"), ...blk(4, false, vc), ...blk(6, true, pic)]);
    const r = parseFlac(file);
    expect(r.title).toBe("Heer");
    expect(r.artist).toBe("Jasleen");
    expect(r.cover?.mime).toBe("image/jpeg");
    expect([...(r.cover?.data ?? [])]).toEqual([5, 6, 7]);
  });
});

describe("fallbackArt", () => {
  it("is deterministic and always an image", () => {
    const a = fallbackArt("Heer", "Jasleen");
    expect(a).toBe(fallbackArt("Heer", "Jasleen"));
    expect(a.startsWith("data:image/svg+xml")).toBe(true);
    expect(fallbackArt("Heer", "Jasleen")).not.toBe(fallbackArt("Other", "Jasleen"));
  });
  it("copes with empty and unusual titles", () => {
    expect(fallbackArt("", "").startsWith("data:image/svg+xml")).toBe(true);
    expect(fallbackArt("<b>&", "x").startsWith("data:image/svg+xml")).toBe(true);
  });
});

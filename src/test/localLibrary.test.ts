import { describe, it, expect } from "vitest";
import { parseFileName } from "@/lib/music/localLibrary";
import { isNativelyStreamable } from "@/lib/music/types";

describe("parseFileName", () => {
  it("splits 'Artist - Title.ext'", () => {
    expect(parseFileName("Arijit Singh - Tum Hi Ho.mp3")).toEqual({ artist: "Arijit Singh", title: "Tum Hi Ho" });
  });
  it("uses the whole name as title when there is no separator", () => {
    expect(parseFileName("voice_note_01.m4a")).toEqual({ artist: "My Files", title: "voice note 01" });
  });
  it("never returns an empty title", () => {
    expect(parseFileName(".mp3").title).not.toBe("");
  });
});

describe("native streamability of the new providers", () => {
  it("jamendo and local play through the native engine", () => {
    expect(isNativelyStreamable({ provider: "jamendo", isStreamable: true })).toBe(true);
    expect(isNativelyStreamable({ provider: "local", isStreamable: true })).toBe(true);
  });
  it("youtube still does not", () => {
    expect(isNativelyStreamable({ provider: "youtube", isStreamable: false })).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { canEditShayari, buildShayariEditPatch } from "@/lib/shayariEdit";

describe("canEditShayari (author only)", () => {
  it("allows the author", () => {
    expect(canEditShayari({ user_id: "me" }, "me")).toBe(true);
  });
  it("refuses the partner's shayari", () => {
    expect(canEditShayari({ user_id: "partner" }, "me")).toBe(false);
  });
  it("refuses when nobody is signed in", () => {
    expect(canEditShayari({ user_id: "me" }, null)).toBe(false);
    expect(canEditShayari({ user_id: "me" }, undefined)).toBe(false);
    expect(canEditShayari({ user_id: "" }, "")).toBe(false);
  });
});

describe("buildShayariEditPatch", () => {
  const original = { title: "Mohabbat", content: "line one\nline two" };

  it("rejects an empty or whitespace-only body", () => {
    expect(buildShayariEditPatch(original, { title: "x", content: "   \n " })).toEqual({ status: "invalid" });
  });

  it("reports no change when the text is identical (ignoring surrounding whitespace)", () => {
    expect(buildShayariEditPatch(original, { title: " Mohabbat ", content: "line one\nline two\n" })).toEqual({ status: "unchanged" });
  });

  it("treats an empty title as null, same as when adding", () => {
    expect(buildShayariEditPatch(original, { title: "  ", content: "line one\nline two" })).toEqual({
      status: "changed", patch: { title: null, content: "line one\nline two" },
    });
  });

  it("returns the trimmed patch when something changed", () => {
    expect(buildShayariEditPatch(original, { title: "Ishq", content: "  new text " })).toEqual({
      status: "changed", patch: { title: "Ishq", content: "new text" },
    });
  });

  it("an untitled shayari stays unchanged when the title is left blank", () => {
    expect(buildShayariEditPatch({ title: null, content: "a" }, { title: "", content: "a" })).toEqual({ status: "unchanged" });
  });
});

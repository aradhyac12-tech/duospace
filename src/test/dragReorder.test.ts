import { describe, it, expect } from "vitest";
import { nextDragStep } from "@/lib/music/dragReorder";

describe("nextDragStep", () => {
  it("does nothing under 60% of a row", () => {
    expect(nextDragStep(30, 56)).toEqual({ step: 0, rest: 30 });
    expect(nextDragStep(-33, 56)).toEqual({ step: 0, rest: -33 });
  });
  it("steps one slot down/up at 60% and carries the remainder", () => {
    expect(nextDragStep(34, 56)).toEqual({ step: 1, rest: -22 });
    expect(nextDragStep(-34, 56)).toEqual({ step: -1, rest: 22 });
  });
  it("has hysteresis: right after a step a small move back does not step again", () => {
    const first = nextDragStep(34, 56);
    expect(nextDragStep(first.rest - 5, 56).step).toBe(0);
  });
  it("falls back to a sane row height", () => {
    expect(nextDragStep(40, 0).step).toBe(1);
  });
});

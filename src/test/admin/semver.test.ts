import { describe, it, expect } from "vitest";
import { compareVersions, parseVersion, updateVerdict } from "@/lib/semver";

describe("semver helpers", () => {
  it("parses loosely", () => {
    expect(parseVersion("v3.20.6")).toEqual([3, 20, 6]);
    expect(parseVersion("3.1")).toEqual([3, 1, 0]);
    expect(parseVersion("junk")).toEqual([0, 0, 0]);
    expect(parseVersion(null)).toEqual([0, 0, 0]);
  });
  it("compares numerically, not lexically", () => {
    expect(compareVersions("3.9.0", "3.10.0")).toBe(-1);
    expect(compareVersions("3.20.6", "3.20.6")).toBe(0);
    expect(compareVersions("4.0.0", "3.99.99")).toBe(1);
  });
  it("update verdict", () => {
    expect(updateVerdict("3.20.6", "3.21.0", "3.0.0")).toBe("available");
    expect(updateVerdict("3.20.6", "3.21.0", "3.21.0")).toBe("required");
    expect(updateVerdict("3.21.0", "3.21.0", "3.0.0")).toBe("ok");
    // unconfigured row (0.0.0 / 0.0.0) must never nag
    expect(updateVerdict("3.20.6", "0.0.0", "0.0.0")).toBe("ok");
  });
});

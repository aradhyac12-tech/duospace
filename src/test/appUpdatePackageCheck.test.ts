import { describe, expect, it } from "vitest";
import { compareSemver, isNewerThanInstalled } from "@/lib/appUpdate/policy";
import type { InstalledApp, ReleaseInfo } from "@/lib/appUpdate/types";

const rel = (over: Partial<ReleaseInfo> = {}): ReleaseInfo => ({
  id: "11111111-1111-4111-8111-111111111111", platform: "android", package_name: "com.duospace.app",
  version_name: "3.23.0", version_code: 32300, release_notes: "", mandatory: false,
  file_size_bytes: 1, sha256: "a".repeat(64), has_file: true, external_url: null, published_at: null, ...over,
});
const inst = (over: Partial<InstalledApp> = {}): InstalledApp => ({
  versionName: "3.22.9", versionCode: 32209, packageName: "com.duospace.app", ...over,
});

describe("isNewerThanInstalled", () => {
  it("offers a genuinely newer build of the same package", () => {
    expect(isNewerThanInstalled(rel(), inst())).toBe(true);
  });
  it("never offers the version that is already installed", () => {
    expect(isNewerThanInstalled(rel({ version_name: "3.22.9", version_code: 32209 }), inst())).toBe(false);
  });
  it("never offers an older release", () => {
    expect(isNewerThanInstalled(rel({ version_name: "3.21.0", version_code: 32100 }), inst())).toBe(false);
  });
  it("ignores a release whose build number was published higher than its version name", () => {
    // Same 3.22.9 the phone already runs, but published with a bigger build number.
    expect(isNewerThanInstalled(rel({ version_name: "3.22.9", version_code: 99999 }), inst())).toBe(false);
  });
  it("ignores a release for a different package", () => {
    expect(isNewerThanInstalled(rel({ package_name: "com.other.app" }), inst())).toBe(false);
  });
  it("still works against a server that reports no package", () => {
    expect(isNewerThanInstalled(rel({ package_name: null }), inst())).toBe(true);
    expect(isNewerThanInstalled(rel(), inst({ packageName: null }))).toBe(true);
  });
});

describe("compareSemver", () => {
  it("compares numerically, not as text", () => {
    expect(compareSemver("3.9.0", "3.10.0")).toBe(-1);
    expect(compareSemver("3.22.9", "3.22.9")).toBe(0);
    expect(compareSemver("4.0.0", "3.99.99")).toBe(1);
  });
  it("returns null for anything that is not x.y.z", () => {
    expect(compareSemver("3.22", "3.22.0")).toBeNull();
    expect(compareSemver("3.22.0-beta", "3.22.0")).toBeNull();
  });
});

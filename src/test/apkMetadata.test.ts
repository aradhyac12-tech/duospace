// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readApkMetadata } from "@/lib/appUpdate/apkMetadata";
import { buildApk, buildZip } from "./helpers/apkFixture";

const blob = (b: Buffer) => new Blob([new Uint8Array(b)]);

describe("readApkMetadata", () => {
  for (const deflate of [false, true]) for (const utf8 of [false, true]) {
    it(`reads version, build and package (deflate=${deflate}, utf8 pool=${utf8})`, async () => {
      const m = await readApkMetadata(blob(buildApk({
        pkg: "com.duospace.app", versionName: "3.22.8", versionCode: 32208, minSdk: 24, deflate, utf8,
      })));
      expect(m).toEqual({ packageName: "com.duospace.app", versionName: "3.22.8", versionCode: 32208, minSdk: 24, debuggable: false });
    });
  }
  it("flags debuggable builds", async () => {
    const m = await readApkMetadata(blob(buildApk({ pkg: "a.b", versionName: "1.0.0", versionCode: 10000, debuggable: true })));
    expect(m.debuggable).toBe(true);
  });
  it("rejects a zip that is not an APK", async () => {
    await expect(readApkMetadata(blob(buildZip([{ name: "x.txt", data: Buffer.from("hi") }])))).rejects.toThrow(/not found/);
    await expect(readApkMetadata(blob(Buffer.from("not a zip at all, just text")))).rejects.toThrow(/zip directory/);
  });
});

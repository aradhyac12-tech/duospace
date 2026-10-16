import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { semverToVersionCode, isValidSemver } from "@/lib/appUpdate/versionCode";
import { decideNetwork, isDismissed, formatBytes, DISMISS_WINDOW_MS } from "@/lib/appUpdate/policy";
import {
  AppUpdateController, KEY_DISMISSED, KEY_DOWNLOAD, downloadFailureMessage, type UpdateDeps,
} from "@/lib/appUpdate/appUpdateController";
import type { ReleaseInfo, ConnectionKind } from "@/lib/appUpdate/types";
import type { DownloadStatus } from "duospace-app-update";
import { semverToVersionCode as buildScriptVersionCode } from "../../scripts/native-version.mjs";

const read = (p: string) => readFileSync(path.resolve(__dirname, "../..", p), "utf8");

const RELEASE: ReleaseInfo = {
  id: "11111111-1111-4111-8111-111111111111", platform: "android", version_name: "3.22.0", version_code: 32200,
  release_notes: "Faster sync", mandatory: false, file_size_bytes: 50_000_000, sha256: "a".repeat(64),
  has_file: true, external_url: null, published_at: "2026-10-03T00:00:00Z",
};

describe("version code", () => {
  it("maps x.y.z monotonically", () => {
    expect(semverToVersionCode("3.22.0")).toBe(32200);
    expect(semverToVersionCode("3.21.1")).toBe(32101);
    expect(semverToVersionCode("3.22.0")).toBeGreaterThan(semverToVersionCode("3.21.99"));
    expect(semverToVersionCode("4.0.0")).toBeGreaterThan(semverToVersionCode("3.99.99"));
  });
  it("rejects what would break monotonicity", () => {
    expect(isValidSemver("3.100.0")).toBe(false);
    expect(isValidSemver("3.1.100")).toBe(false);
    expect(isValidSemver("0.0.0")).toBe(false);
    expect(isValidSemver("3.22")).toBe(false);
    expect(isValidSemver("v3.22.0")).toBe(false);
  });
  it("the app and the build script use the same formula", () => {
    for (const v of ["0.0.1", "1.2.3", "3.22.0", "3.99.99", "200.0.0"]) {
      expect(buildScriptVersionCode(v)).toBe(semverToVersionCode(v));
    }
    expect(() => buildScriptVersionCode("3.100.0")).toThrow();
  });
  it("the shipped native project is stamped with package.json's version", () => {
    const pkg = JSON.parse(read("package.json")) as { version: string };
    const gradle = read("android/app/build.gradle");
    expect(gradle).toContain(`versionCode ${semverToVersionCode(pkg.version)}`);
    expect(gradle).toContain(`versionName "${pkg.version}"`);
    expect(read("scripts/patch-native-permissions.mjs")).toContain("stampNativeVersion();");
  });
});

describe("network policy", () => {
  it("never starts offline", () => {
    expect(decideNetwork("none", "always")).toEqual({ action: "offline" });
    expect(decideNetwork("none", "ask", true)).toEqual({ action: "offline" });
  });
  it("wifi-only never allows cellular, even on cellular", () => {
    expect(decideNetwork("cellular", "wifi-only")).toEqual({ action: "start", allowCellular: false });
    expect(decideNetwork("wifi", "wifi-only")).toEqual({ action: "start", allowCellular: false });
  });
  it("ask prompts on cellular only, and stays Wi-Fi-only on Wi-Fi", () => {
    expect(decideNetwork("cellular", "ask")).toEqual({ action: "ask" });
    expect(decideNetwork("wifi", "ask")).toEqual({ action: "start", allowCellular: false });
    expect(decideNetwork("unknown", "ask")).toEqual({ action: "start", allowCellular: false });
  });
  it("always allows cellular; an explicit answer beats the policy", () => {
    expect(decideNetwork("wifi", "always")).toEqual({ action: "start", allowCellular: true });
    expect(decideNetwork("cellular", "wifi-only", true)).toEqual({ action: "start", allowCellular: true });
    expect(decideNetwork("cellular", "always", false)).toEqual({ action: "start", allowCellular: false });
  });
  it("later hides an optional release for 24h, never a mandatory one", () => {
    const now = 1_000_000_000;
    const rec = { code: 32200, at: now - 1000 };
    expect(isDismissed(rec, 32200, false, now)).toBe(true);
    expect(isDismissed(rec, 32200, true, now)).toBe(false);
    expect(isDismissed(rec, 32300, false, now)).toBe(false);
    expect(isDismissed({ code: 32200, at: now - DISMISS_WINDOW_MS - 1 }, 32200, false, now)).toBe(false);
    expect(isDismissed(null, 32200, false, now)).toBe(false);
  });
  it("formats sizes and failures", () => {
    expect(formatBytes(50_000_000)).toBe("47.7 MB");
    expect(formatBytes(null)).toBe("");
    expect(downloadFailureMessage(403)).toMatch(/expired/);
    expect(downloadFailureMessage(1006)).toMatch(/storage/);
  });
});

function makeDeps(over: Partial<UpdateDeps> = {}, opts: { connection?: ConnectionKind; status?: DownloadStatus } = {}) {
  const mem = new Map<string, string>();
  let status: DownloadStatus = opts.status ?? { status: "success", bytesDownloaded: 50_000_000, totalBytes: 50_000_000 };
  let connection: ConnectionKind = opts.connection ?? "wifi";
  const plugin = {
    startDownload: vi.fn(async () => ({ downloadId: "42" })),
    getDownloadStatus: vi.fn(async () => status),
    cancelDownload: vi.fn(async () => undefined),
    installApk: vi.fn(async () => ({ status: "started" as const })),
    openInstallSettings: vi.fn(async () => undefined),
    getInstallSource: vi.fn(async () => ({ installer: null })),
    cleanup: vi.fn(async () => undefined),
  };
  const deps: UpdateDeps = {
    platform: () => "android",
    detectSupport: async () => true,
    getInstalled: async () => ({ versionName: "3.21.1", versionCode: 32101 }),
    getConnection: async () => connection,
    fetchLatest: vi.fn(async () => ({ release: RELEASE, error: null })),
    requestDownload: vi.fn(async () => ({ kind: "apk" as const, url: "https://x/y.apk", file_name: "duospace-3.22.0-32200.apk", sha256: "a".repeat(64), size: 50_000_000 })),
    plugin,
    store: {
      get: async (k) => mem.get(k) ?? null,
      set: async (k, v) => { mem.set(k, v); },
      remove: async (k) => { mem.delete(k); },
    },
    openUrl: vi.fn(),
    now: () => 1_000_000,
    pollIntervalMs: 5,
    ...over,
  };
  return { deps, plugin, mem, setStatus: (s: DownloadStatus) => { status = s; }, setConnection: (c: ConnectionKind) => { connection = c; } };
}

describe("AppUpdateController", () => {
  it("offers a newer published release", async () => {
    const { deps } = makeDeps();
    const c = new AppUpdateController(deps);
    await c.init();
    expect(c.getSnapshot().phase).toBe("available");
    expect(c.getSnapshot().release?.version_name).toBe("3.22.0");
    expect(deps.fetchLatest).toHaveBeenCalledWith("android", 32101, { versionCode: 32101, versionName: "3.21.1" });
  });

  it("is up to date when nothing newer is published", async () => {
    const { deps } = makeDeps({ fetchLatest: vi.fn(async () => ({ release: null, error: null })) });
    const c = new AppUpdateController(deps);
    await c.init();
    expect(c.getSnapshot().phase).toBe("up_to_date");
  });

  it("does nothing (and never prompts) where self-update is unsupported, e.g. Play installs", async () => {
    const { deps } = makeDeps({ detectSupport: async () => false });
    const c = new AppUpdateController(deps);
    await c.init();
    expect(c.getSnapshot().supported).toBe(false);
    expect(deps.fetchLatest).not.toHaveBeenCalled();
    await c.startDownload();
    expect(c.getSnapshot().phase).toBe("idle");
  });

  it("a silent check failure shows nothing; a manual one reports it", async () => {
    const { deps } = makeDeps({ fetchLatest: vi.fn(async () => ({ release: null, error: "boom" })) });
    const c = new AppUpdateController(deps);
    await c.init();
    expect(c.getSnapshot().phase).toBe("idle");
    await c.check({ silent: false });
    expect(c.getSnapshot().phase).toBe("error");
  });

  it("Wi-Fi only on mobile data: starts a Wi-Fi-only download that waits", async () => {
    const { deps, plugin } = makeDeps({}, { connection: "cellular", status: { status: "paused", bytesDownloaded: 0, totalBytes: 50_000_000, waitingForWifi: true } });
    const c = new AppUpdateController(deps);
    await c.init();
    await c.setCellularPolicy("wifi-only");
    await c.startDownload();
    expect(plugin.startDownload).toHaveBeenCalledWith(expect.objectContaining({ allowCellular: false }));
    expect(c.getSnapshot().phase).toBe("waiting_wifi");
  });

  it("ask policy on mobile data asks first, then honours the answer", async () => {
    const { deps, plugin } = makeDeps({}, { connection: "cellular" });
    const c = new AppUpdateController(deps);
    await c.init();
    await c.startDownload();
    expect(c.getSnapshot().phase).toBe("confirm_cellular");
    expect(plugin.startDownload).not.toHaveBeenCalled();
    await c.startDownload({ allowCellular: true });
    expect(plugin.startDownload).toHaveBeenCalledWith(expect.objectContaining({ allowCellular: true }));
  });

  it("refuses to start offline", async () => {
    const { deps, plugin } = makeDeps({}, { connection: "none" });
    const c = new AppUpdateController(deps);
    await c.init();
    await c.startDownload();
    expect(c.getSnapshot().phase).toBe("error");
    expect(plugin.startDownload).not.toHaveBeenCalled();
  });

  it("downloads, becomes ready and installs with the published hash and version", async () => {
    const { deps, plugin } = makeDeps();
    const c = new AppUpdateController(deps);
    await c.init();
    await c.startDownload();
    await vi.waitFor(() => expect(c.getSnapshot().phase).toBe("ready"));
    await c.install();
    expect(plugin.installApk).toHaveBeenCalledWith({
      fileName: "duospace-3.22.0-32200.apk", sha256: "a".repeat(64), expectedVersionCode: 32200,
    });
  });

  it("asks for the install permission and retries when the app returns", async () => {
    const { deps, plugin } = makeDeps();
    plugin.installApk.mockResolvedValueOnce({ status: "needs_permission" as never });
    const c = new AppUpdateController(deps);
    await c.init();
    await c.startDownload();
    await vi.waitFor(() => expect(c.getSnapshot().phase).toBe("ready"));
    await c.install();
    expect(c.getSnapshot().phase).toBe("needs_permission");
    await c.handleResume();
    expect(plugin.installApk).toHaveBeenCalledTimes(2);
  });

  it("a corrupted / mismatched file is dropped and reported, never retried blindly", async () => {
    const { deps, plugin, mem } = makeDeps();
    plugin.installApk.mockRejectedValueOnce(Object.assign(new Error("Downloaded file is corrupted."), { code: "HASH_MISMATCH" }));
    const c = new AppUpdateController(deps);
    await c.init();
    await c.startDownload();
    await vi.waitFor(() => expect(c.getSnapshot().phase).toBe("ready"));
    await c.install();
    expect(c.getSnapshot().phase).toBe("error");
    expect(mem.has(KEY_DOWNLOAD)).toBe(false);
  });

  it("a failed download surfaces a message and clears state", async () => {
    const { deps, mem } = makeDeps({}, { status: { status: "failed", bytesDownloaded: 0, totalBytes: 0, reasonCode: 403 } });
    const c = new AppUpdateController(deps);
    await c.init();
    await c.startDownload();
    await vi.waitFor(() => expect(c.getSnapshot().phase).toBe("error"));
    expect(c.getSnapshot().error).toMatch(/expired/);
    expect(mem.has(KEY_DOWNLOAD)).toBe(false);
  });

  it("Later hides an optional update but a mandatory one can't be dismissed", async () => {
    const opt = makeDeps();
    const c1 = new AppUpdateController(opt.deps);
    await c1.init();
    await c1.dismiss();
    expect(c1.getSnapshot().dismissed).toBe(true);
    expect(opt.mem.has(KEY_DISMISSED)).toBe(true);

    const man = makeDeps({ fetchLatest: vi.fn(async () => ({ release: { ...RELEASE, mandatory: true }, error: null })) });
    const c2 = new AppUpdateController(man.deps);
    await c2.init();
    await c2.dismiss();
    expect(c2.getSnapshot().dismissed).toBe(false);
    expect(man.mem.has(KEY_DISMISSED)).toBe(false);
  });

  it("re-attaches to a download that survived an app restart", async () => {
    const { deps, mem } = makeDeps();
    mem.set(KEY_DOWNLOAD, JSON.stringify({
      releaseId: RELEASE.id, downloadId: "42", fileName: "duospace-3.22.0-32200.apk",
      sha256: "a".repeat(64), versionCode: 32200, allowCellular: false,
    }));
    const c = new AppUpdateController(deps);
    await c.init();
    expect(c.getSnapshot().phase).toBe("ready");
    await c.install();
    expect(deps.plugin.installApk).toHaveBeenCalled();
  });

  it("drops a stale download when a different release is now current", async () => {
    const { deps, mem, plugin } = makeDeps();
    mem.set(KEY_DOWNLOAD, JSON.stringify({
      releaseId: "22222222-2222-4222-8222-222222222222", downloadId: "7", fileName: "duospace-3.21.5-32105.apk",
      sha256: "b".repeat(64), versionCode: 32105, allowCellular: false,
    }));
    const c = new AppUpdateController(deps);
    await c.init();
    expect(plugin.cancelDownload).toHaveBeenCalledWith({ downloadId: "7" });
    expect(mem.has(KEY_DOWNLOAD)).toBe(false);
    expect(c.getSnapshot().phase).toBe("available");
  });

  it("cancels the download when the admin unpublishes the release mid-flight", async () => {
    const latest = vi.fn()
      .mockResolvedValueOnce({ release: RELEASE, error: null })
      .mockResolvedValue({ release: null, error: null });
    const { deps, plugin } = makeDeps({ fetchLatest: latest }, { status: { status: "running", bytesDownloaded: 1, totalBytes: 2 } });
    const c = new AppUpdateController(deps);
    await c.init();
    await c.startDownload();
    await vi.waitFor(() => expect(c.getSnapshot().phase).toBe("downloading"));
    await c.check({ silent: true });
    expect(plugin.cancelDownload).toHaveBeenCalled();
    expect(c.getSnapshot().phase).toBe("up_to_date");
  });

  it("after the app is updated, the leftover APK is cleaned up", async () => {
    const { deps, mem, plugin } = makeDeps({ fetchLatest: vi.fn(async () => ({ release: null, error: null })) });
    mem.set(KEY_DOWNLOAD, "{}");
    const c = new AppUpdateController(deps);
    await c.init();
    expect(plugin.cleanup).toHaveBeenCalled();
    expect(mem.has(KEY_DOWNLOAD)).toBe(false);
  });

  it("iOS opens the link instead of downloading in-app", async () => {
    const { deps, plugin } = makeDeps({
      platform: () => "ios",
      requestDownload: vi.fn(async () => ({ kind: "ios-ota" as const, url: "itms-services://?action=download-manifest&url=x" })),
      fetchLatest: vi.fn(async () => ({ release: { ...RELEASE, platform: "ios" as const }, error: null })),
    });
    const c = new AppUpdateController(deps);
    await c.init();
    await c.startDownload();
    expect(deps.openUrl).toHaveBeenCalledWith("itms-services://?action=download-manifest&url=x");
    expect(plugin.startDownload).not.toHaveBeenCalled();
  });
});

// Static guards on the security-relevant SQL / config. These do not replace
// running the migration; they stop an edit from silently removing a gate.
describe("OTA access control (static)", () => {
  const sql = read("supabase/migrations/20261003190000_app_releases_ota.sql");

  it("every admin RPC asserts the admin and logs to the audit trail", () => {
    for (const fn of ["admin_create_app_release", "admin_set_app_release_status", "admin_delete_app_release"]) {
      const start = sql.indexOf(`FUNCTION public.${fn}(`);
      expect(start, fn).toBeGreaterThan(-1);
      const body = sql.slice(start, sql.indexOf("$$;", sql.indexOf("$$", start) + 2));
      expect(body, fn).toContain("PERFORM private.assert_admin();");
      expect(body, fn).toContain("private.admin_log(");
      const grants = sql.slice(start);
      expect(grants).toContain(`REVOKE ALL ON FUNCTION public.${fn}(`);
    }
  });

  it("the table has RLS, an admin-only SELECT policy and no write grant for clients", () => {
    expect(sql).toContain("ALTER TABLE public.app_releases ENABLE ROW LEVEL SECURITY;");
    expect(sql).toContain("REVOKE ALL ON TABLE public.app_releases FROM anon;");
    expect(sql).toMatch(/GRANT SELECT ON TABLE public\.app_releases TO authenticated;/);
    expect(sql).not.toMatch(/GRANT (ALL|INSERT|UPDATE|DELETE)[^;]*ON TABLE public\.app_releases TO (authenticated|anon)/);
    expect(sql).toMatch(/app_releases_admin_select[\s\S]*?USING \(public\.is_app_admin\(\)\)/);
  });

  it("strips Supabase's default table grants (TRUNCATE bypasses RLS)", () => {
    const fix = read("supabase/migrations/20261003191000_app_releases_revoke_default_grants.sql");
    expect(fix).toContain("REVOKE ALL ON TABLE public.app_releases FROM authenticated, anon, public;");
    expect(fix).toContain("GRANT SELECT ON TABLE public.app_releases TO authenticated;");
    expect(fix).not.toMatch(/GRANT (ALL|INSERT|UPDATE|DELETE|TRUNCATE)[^;]*TO authenticated/);
  });

  it("the bucket is private and every storage policy requires the admin", () => {
    expect(sql).toMatch(/'app-releases', 'app-releases', false/);
    const policies = sql.match(/CREATE POLICY "app_releases_objects_[a-z_]+"[\s\S]*?;\n/g) ?? [];
    expect(policies.length).toBe(4);
    for (const p of policies) expect(p).toContain("public.is_app_admin()");
    expect(sql).not.toMatch(/TO anon[^;]*storage\.objects/);
  });

  it("anon can read only the metadata RPC, never the storage path", () => {
    const fn = sql.slice(sql.indexOf("FUNCTION public.get_latest_app_release"), sql.indexOf("-- Admin RPCs"));
    expect(fn).not.toContain("file_path'");
    expect(fn).toContain("GRANT EXECUTE ON FUNCTION public.get_latest_app_release(text, integer) TO anon");
  });

  it("the download/manifest functions are deployed without a JWT, on purpose", () => {
    const cfg = read("supabase/config.toml");
    expect(cfg).toContain("[functions.app-release-download]\nverify_jwt = false");
    expect(cfg).toContain("[functions.app-release-ios-manifest]\nverify_jwt = false");
  });

  it("the download function only serves published releases", () => {
    const src = read("supabase/functions/app-release-download/index.ts");
    expect(src).toContain('rel.status !== "published"');
    expect(src).not.toContain("file_path:");
  });
});

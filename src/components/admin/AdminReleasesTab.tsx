import { useMemo, useRef, useState } from "react";
import { Loader2, Upload, Rocket, EyeOff, Trash2, Smartphone, Apple } from "lucide-react";
import ConfirmActionDialog from "@/components/settings/ConfirmActionDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { hapticMedium } from "@/lib/haptics";
import { adminApi, type AppRelease, type ReleasePlatform } from "@/lib/admin/adminApi";
import { formatBytes } from "@/lib/appUpdate";
import { isValidSemver, semverToVersionCode } from "@/lib/appUpdate/versionCode";
import { readApkMetadata } from "@/lib/appUpdate/apkMetadata";
import { APP_VERSION } from "@/lib/errors/DuoSpaceError";
import { Empty, Spinner, useAdminList } from "./AdminBits";

/**
 * Admin-only: upload an APK/IPA and publish it to every install. Only the
 * allow-listed ADMIN can do this; the bucket policies and every
 * admin_*_app_release RPC re-check that in Postgres, so a modified client can
 * neither upload nor publish.
 */
const MAX_BYTES = 500 * 1024 * 1024;
/** Must equal appId in capacitor.config.json: an APK with another id would not update the installed app. */
const APP_PACKAGE_ID = "com.duospace.app";
const DEFAULT_NOTES = "Bug fixes and improvements.";

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const AdminReleasesTab = () => {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const { rows: releases, loading, reload } = useAdminList(() => adminApi.listReleases(), []);

  const [platform, setPlatform] = useState<ReleasePlatform>("android");
  const [versionName, setVersionName] = useState("");
  const [notes, setNotes] = useState("");
  const [mandatory, setMandatory] = useState(false);
  const [publishNow, setPublishNow] = useState(true);
  const [externalUrl, setExternalUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [detected, setDetected] = useState<string | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  /** Read from the APK itself: this, not a formula, is what installed apps will report. */
  const [apkCode, setApkCode] = useState<number | null>(null);
  const [apkPackage, setApkPackage] = useState<string | null>(null);

  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "publish" | "delete"; row: AppRelease } | null>(null);

  const code = useMemo(
    () => apkCode ?? (isValidSemver(versionName) ? semverToVersionCode(versionName) : null),
    [apkCode, versionName],
  );
  const uploading = stage !== null;
  const fail = (title: string, description?: string) => toast({ title, description, variant: "destructive" });

  /** Choosing a file fills in platform + version automatically; the admin only taps Upload. */
  const onPickFile = async (f: File | null) => {
    setFile(f); setDetected(null); setFileProblem(null); setApkCode(null); setApkPackage(null);
    if (!f) return;
    const lower = f.name.toLowerCase();
    if (lower.endsWith(".ipa")) { setPlatform("ios"); return; }
    if (!lower.endsWith(".apk")) { setFileProblem("Choose an .apk or .ipa file"); return; }
    setPlatform("android");
    setStage("Reading APK…");
    try {
      const m = await readApkMetadata(f);
      if (!m.versionName || !isValidSemver(m.versionName)) {
        setFileProblem(`The APK's version "${m.versionName ?? "?"}" is not x.y.z; enter it manually or rebuild.`);
        return;
      }
      setVersionName(m.versionName);
      setApkPackage(m.packageName);
      if (m.versionCode && m.versionCode > 0) setApkCode(m.versionCode);
      setDetected(`${m.versionName} · build ${m.versionCode ?? "?"} · ${m.packageName ?? "unknown package"}`);
      if (m.packageName !== APP_PACKAGE_ID) {
        setFileProblem(`This APK is ${m.packageName ?? "unknown"}, not ${APP_PACKAGE_ID}; installed apps would not update to it.`);
      } else if (m.versionCode === null || !Number.isInteger(m.versionCode) || m.versionCode <= 0) {
        setFileProblem("The APK has no readable build number. Rebuild it, or enter the version manually.");
      } else if (m.debuggable) {
        setFileProblem("This is a debug build. Upload the release-signed APK.");
      }
    } catch (e) {
      setFileProblem(`Couldn't read the APK (${e instanceof Error ? e.message : String(e)}). Enter the version manually.`);
    } finally {
      setStage(null);
    }
  };

  const submit = async () => {
    if (fileProblem && file && !fileProblem.startsWith("Couldn't read")) return fail("Fix the APK first", fileProblem);
    if (code === null) return fail("Version must look like 3.22.0 (minor and patch 0-99)");
    const link = externalUrl.trim();
    if (!file && !(platform === "ios" && link)) {
      return fail(platform === "ios" ? "Choose an .ipa or enter a store link" : "Choose an .apk");
    }
    if (link && !/^https:\/\/\S+$/.test(link)) return fail("The link must start with https://");
    if (releases.some((r) => r.platform === platform && r.version_code === code)) {
      return fail(`${platform} version ${versionName} already exists`);
    }
    if (file) {
      const ext = platform === "android" ? ".apk" : ".ipa";
      if (!file.name.toLowerCase().endsWith(ext)) return fail(`Expected a ${ext} file`);
      if (file.size > MAX_BYTES) return fail("File is larger than 500 MB");
    }

    try {
      setStage("Checking file…");
      const sha = file ? await sha256Hex(file) : null;
      await adminApi.createRelease({
        platform, versionName, versionCode: code, notes: notes.trim() || DEFAULT_NOTES, mandatory, publish: publishNow,
        file, sha256: sha, externalUrl: link || null, packageName: file ? (apkPackage ?? APP_PACKAGE_ID) : APP_PACKAGE_ID, onStage: setStage,
      });
      hapticMedium();
      toast({ title: publishNow ? `Published ${versionName}` : `Saved ${versionName} as a draft` });
      setVersionName(""); setNotes(""); setMandatory(false); setExternalUrl(""); setFile(null); setDetected(null); setFileProblem(null); setApkCode(null); setApkPackage(null);
      if (fileRef.current) fileRef.current.value = "";
      reload();
    } catch (e) {
      fail("Upload failed", e instanceof Error ? e.message : String(e));
    } finally {
      setStage(null);
    }
  };

  const run = async (row: AppRelease, op: () => Promise<unknown>, errTitle: string): Promise<boolean> => {
    setRowBusy(row.id);
    try {
      await op();
      hapticMedium();
      reload();
      return true;
    } catch (e) {
      fail(errTitle, e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setRowBusy(null);
    }
  };

  return (
    <div className="space-y-6 pb-6">
      <div className="bg-card rounded-2xl border border-border/60 p-4 space-y-4">
        <p className="text-sm font-medium text-foreground">New release</p>

        <div className="grid grid-cols-2 gap-2">
          {(["android", "ios"] as const).map((p) => (
            <Button key={p} type="button" variant={platform === p ? "default" : "outline"} onClick={() => setPlatform(p)} disabled={uploading}>
              {p === "android" ? <Smartphone className="h-4 w-4" /> : <Apple className="h-4 w-4" />}
              {p === "android" ? "Android (.apk)" : "iOS (.ipa)"}
            </Button>
          ))}
        </div>

        <div className="space-y-1">
          <Input
            value={versionName}
            onChange={(e) => setVersionName(e.target.value.trim())}
            placeholder={`Auto-filled from the file (e.g. ${APP_VERSION})`}
            inputMode="decimal"
            disabled={uploading}
          />
          <p className="text-[11px] text-muted-foreground">
            {code !== null
              ? `Build number ${code}${apkCode ? " (read from the APK)" : ""}. Installed apps compare this number and the version name against their own, so an app already on this version is never offered it.`
              : "Use x.y.z, the same as package.json for that build."}
          </p>
        </div>

        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What's new (optional, shown to users)" rows={4} maxLength={4000} disabled={uploading} />

        <div className="space-y-1">
          <input
            ref={fileRef}
            type="file"
            accept=".apk,.ipa,application/vnd.android.package-archive"
            onChange={(e) => void onPickFile(e.target.files?.[0] ?? null)}
            disabled={uploading}
            className="block w-full text-sm text-foreground file:mr-3 file:rounded-full file:border-0 file:bg-accent/15 file:px-4 file:py-2 file:text-sm file:font-medium file:text-accent"
          />
          {file && <p className="text-[11px] text-muted-foreground">{file.name} · {formatBytes(file.size)}</p>}
          {detected && !fileProblem && <p className="text-[11px] text-success">Detected {detected}</p>}
          {fileProblem && <p className="text-[11px] text-destructive">{fileProblem}</p>}
        </div>

        {platform === "ios" && (
          <div className="space-y-1">
            <Input value={externalUrl} onChange={(e) => setExternalUrl(e.target.value)} placeholder="Or an App Store / TestFlight link (https://…)" disabled={uploading} />
            <p className="text-[11px] text-muted-foreground">
              An .ipa installs over the air only if it is ad-hoc/enterprise signed for the device. For App Store or TestFlight builds, give the link instead.
            </p>
          </div>
        )}

        <label className="flex items-center justify-between gap-3">
          <span>
            <span className="block text-sm text-foreground">Required update</span>
            <span className="block text-[11px] text-muted-foreground">Blocks the app until installed. Unpublish to lift it.</span>
          </span>
          <Switch checked={mandatory} onCheckedChange={setMandatory} disabled={uploading} />
        </label>
        <label className="flex items-center justify-between gap-3">
          <span className="text-sm text-foreground">Publish immediately</span>
          <Switch checked={publishNow} onCheckedChange={setPublishNow} disabled={uploading} />
        </label>

        <Button className="w-full" onClick={() => void submit()} disabled={uploading}>
          {uploading ? <><Loader2 className="h-4 w-4 animate-spin" /> {stage}</> : <><Upload className="h-4 w-4" /> Upload</>}
        </Button>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">Releases</p>
        {loading ? <Spinner /> : releases.length === 0 ? (
          <Empty>No releases yet.</Empty>
        ) : (
          <div className="bg-card rounded-2xl border border-border/60 divide-y divide-border/40 overflow-hidden">
            {releases.map((r) => (
              <div key={r.id} className="px-4 py-3.5 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium text-foreground">{r.platform === "android" ? "Android" : "iOS"} {r.version_name}</p>
                  <span className="text-[10px] uppercase tracking-wide rounded-full bg-secondary px-2 py-0.5 text-muted-foreground">{r.status}</span>
                  {r.mandatory && <span className="text-[10px] uppercase tracking-wide rounded-full bg-warning/15 px-2 py-0.5 text-warning">required</span>}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  build {r.version_code}
                  {r.file_size_bytes ? ` · ${formatBytes(r.file_size_bytes)}` : ""}
                  {r.sha256 ? ` · sha256 ${r.sha256.slice(0, 10)}…` : ""}
                  {r.external_url ? " · store link" : ""}
                </p>
                <div className="flex gap-2">
                  {r.status === "published" ? (
                    <Button size="sm" variant="outline" disabled={rowBusy === r.id}
                      onClick={() => void run(r, () => adminApi.setReleaseStatus(r.id, "revoked"), "Couldn't unpublish")}>
                      <EyeOff className="h-3.5 w-3.5" /> Unpublish
                    </Button>
                  ) : (
                    <Button size="sm" disabled={rowBusy === r.id}
                      onClick={() => r.mandatory
                        ? setConfirm({ kind: "publish", row: r })
                        : void run(r, () => adminApi.setReleaseStatus(r.id, "published"), "Couldn't publish")}>
                      <Rocket className="h-3.5 w-3.5" /> Publish
                    </Button>
                  )}
                  {r.status !== "published" && (
                    <Button size="sm" variant="outline" disabled={rowBusy === r.id} onClick={() => setConfirm({ kind: "delete", row: r })}>
                      <Trash2 className="h-3.5 w-3.5" /> Delete
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="text-[11px] text-muted-foreground px-1">
          If no release is published, installs fall back to the link-only notice set under Announce → App update.
        </p>
      </div>

      {confirm && (
        <ConfirmActionDialog
          open
          onOpenChange={(o) => { if (!o) setConfirm(null); }}
          title={confirm.kind === "publish" ? `Publish required update ${confirm.row.version_name}?` : `Delete ${confirm.row.version_name}?`}
          whatHappens={confirm.kind === "publish"
            ? "Every install older than this build is blocked until it updates."
            : "The uploaded file and the release entry are removed."}
          dataAffected={confirm.kind === "publish" ? "All users on this platform." : "Only this release."}
          reversible={confirm.kind === "publish"}
          reversibleNote={confirm.kind === "publish" ? "Unpublish it to lift the block." : "You would have to upload it again."}
          authRequired={false}
          destructive={confirm.kind === "delete"}
          confirmLabel={confirm.kind === "publish" ? "Publish" : "Delete"}
          onConfirm={async () => {
            const row = confirm.row;
            return confirm.kind === "publish"
              ? run(row, () => adminApi.setReleaseStatus(row.id, "published"), "Couldn't publish")
              : run(row, () => adminApi.deleteRelease(row), "Couldn't delete");
          }}
        />
      )}
    </div>
  );
};

export default AdminReleasesTab;

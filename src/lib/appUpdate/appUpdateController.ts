/**
 * In-app update controller (OTA APK/IPA releases published by the admin).
 *
 * Framework-free state machine so it can be unit-tested and shared by the
 * global prompt and the Settings page. All I/O goes through `UpdateDeps`.
 *
 * Android: check -> (network policy) -> signed URL -> DownloadManager (Wi-Fi
 * only or Wi-Fi+cellular, OS-enforced, resumable) -> verified install intent.
 * iOS: check -> open an itms-services (ad-hoc/enterprise IPA) or external
 * (App Store / TestFlight) link; iOS offers no in-app installer.
 *
 * Nothing here can publish anything; releases only exist if the admin
 * published them (enforced in Postgres, see 20261003190000_app_releases_ota.sql).
 */
import type { DuospaceAppUpdatePlugin } from "duospace-app-update";
import { decideNetwork, isDismissed, isNewerThanInstalled } from "./policy";
import type {
  CellularPolicy,
  ConnectionKind,
  DownloadResponse,
  InstalledApp,
  ReleaseInfo,
  UpdatePhase,
  UpdatePlatform,
  UpdateState,
} from "./types";

export const KEY_POLICY = "duo-update-cellular-policy";
export const KEY_DISMISSED = "duo-update-dismissed";
export const KEY_DOWNLOAD = "duo-update-download";

export const RECHECK_ON_RESUME_MS = 10 * 60 * 1000;

export interface UpdateDeps {
  platform(): "android" | "ios" | "web";
  detectSupport(): Promise<boolean>;
  getInstalled(): Promise<InstalledApp | null>;
  getConnection(): Promise<ConnectionKind>;
  fetchLatest(
    platform: UpdatePlatform,
    currentCode: number,
    installed?: InstalledApp,
  ): Promise<{ release: ReleaseInfo | null; error: string | null }>;
  requestDownload(releaseId: string): Promise<DownloadResponse>;
  plugin: DuospaceAppUpdatePlugin;
  store: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
  };
  openUrl(url: string): void;
  now(): number;
  pollIntervalMs?: number;
}

interface StoredDownload {
  releaseId: string;
  downloadId: string;
  fileName: string;
  sha256: string;
  versionCode: number;
  allowCellular: boolean;
}

const ACTIVE: ReadonlySet<UpdatePhase> = new Set<UpdatePhase>([
  "confirm_cellular",
  "downloading",
  "waiting_wifi",
  "ready",
  "installing",
  "needs_permission",
  "handoff",
]);

function isPolicy(v: unknown): v is CellularPolicy {
  return v === "wifi-only" || v === "ask" || v === "always";
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function downloadFailureMessage(reason?: number): string {
  if (reason === 1006) return "Not enough storage space to download the update.";
  if (reason && reason >= 400 && reason <= 599) {
    return "The download link expired or the file is no longer available. Please try again.";
  }
  return "The download failed. Please try again.";
}

function errMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  return "Something went wrong. Please try again.";
}

export class AppUpdateController {
  private state: UpdateState = {
    phase: "idle",
    supported: false,
    installed: null,
    release: null,
    progress: { bytes: 0, total: 0 },
    error: null,
    lastCheckedAt: null,
    connection: "unknown",
    cellularPolicy: "ask",
    dismissed: false,
  };
  private listeners = new Set<() => void>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private download: StoredDownload | null = null;
  private busy = false;
  private inited = false;
  private supportChecked = false;

  constructor(private deps: UpdateDeps) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): UpdateState => this.state;

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  async init(): Promise<void> {
    if (this.inited) return;
    this.inited = true;
    const policy = await this.deps.store.get(KEY_POLICY);
    if (isPolicy(policy)) this.set({ cellularPolicy: policy });
    await this.ensureSupport();
    if (this.state.supported) await this.check({ silent: true });
  }

  private async ensureSupport(): Promise<void> {
    if (this.supportChecked) return;
    this.supportChecked = true;
    const supported = await this.deps.detectSupport();
    const installed = supported ? await this.deps.getInstalled() : null;
    this.set({ supported: supported && installed !== null, installed });
  }

  async check(opts: { silent: boolean } = { silent: false }): Promise<void> {
    await this.ensureSupport();
    const { supported, installed } = this.state;
    if (!supported || !installed) return;

    const active = ACTIVE.has(this.state.phase);
    if (!opts.silent && !active) this.set({ phase: "checking", error: null });

    const platform = this.deps.platform() as UpdatePlatform;
    const fetched = await this.deps.fetchLatest(platform, installed.versionCode, installed);
    const error = fetched.error;
    // Local safety net: whatever the server says, never offer a build that is
    // for another package or is not strictly newer than what is installed.
    const release = fetched.release && isNewerThanInstalled(fetched.release, installed) ? fetched.release : null;
    const now = this.deps.now();

    if (error) {
      if (!opts.silent && !active) {
        this.set({ phase: "error", error: "Couldn't check for updates. Check your connection and try again." });
      }
      return;
    }
    this.set({ lastCheckedAt: now });

    if (!release) {
      if (active) {
        // Unpublished (or already installed) while we were mid-flight.
        if (this.download) await this.cancel();
        this.set({ phase: "up_to_date", release: null, dismissed: false });
      } else {
        this.set({ phase: "up_to_date", release: null, dismissed: false });
        await this.tidyAfterUpdate();
      }
      return;
    }

    // A download/install already in flight for this very release keeps going.
    if (active && this.state.release?.id === release.id) {
      this.set({ release });
      return;
    }
    // Superseded by a newer release: drop the stale download first.
    if (active && this.download) await this.cancel();

    const dismissed = isDismissed(
      parseJson<{ code: number; at: number }>(await this.deps.store.get(KEY_DISMISSED)),
      release.version_code,
      release.mandatory,
      now,
    );
    this.set({
      release,
      phase: "available",
      dismissed,
      error: null,
      progress: { bytes: 0, total: release.file_size_bytes ?? 0 },
    });
    await this.resumeStoredDownload(release);
  }

  /** After the app has been updated: forget the stored download and delete the APK. */
  private async tidyAfterUpdate(): Promise<void> {
    if (!(await this.deps.store.get(KEY_DOWNLOAD))) return;
    await this.deps.store.remove(KEY_DOWNLOAD);
    this.download = null;
    if (this.deps.platform() === "android") {
      try {
        await this.deps.plugin.cleanup();
      } catch {
        /* best effort */
      }
    }
  }

  /** Re-attach to a download that survived an app restart. */
  private async resumeStoredDownload(release: ReleaseInfo): Promise<void> {
    const stored = parseJson<StoredDownload>(await this.deps.store.get(KEY_DOWNLOAD));
    if (!stored) return;
    if (stored.releaseId !== release.id || this.deps.platform() !== "android") {
      try {
        await this.deps.plugin.cancelDownload({ downloadId: stored.downloadId });
      } catch {
        /* already gone */
      }
      await this.deps.store.remove(KEY_DOWNLOAD);
      return;
    }
    try {
      const st = await this.deps.plugin.getDownloadStatus({ downloadId: stored.downloadId });
      if (st.status === "failed" || st.status === "missing") {
        await this.deps.store.remove(KEY_DOWNLOAD);
        return;
      }
      this.download = stored;
      if (st.status === "success") {
        this.set({ phase: "ready", progress: { bytes: st.bytesDownloaded, total: st.totalBytes } });
      } else {
        this.set({ phase: stored.allowCellular ? "downloading" : "waiting_wifi" });
        this.startPolling();
      }
    } catch {
      await this.deps.store.remove(KEY_DOWNLOAD);
    }
  }

  async startDownload(opts: { allowCellular?: boolean } = {}): Promise<void> {
    const release = this.state.release;
    if (!release || this.busy) return;
    if (this.deps.platform() === "ios") return this.handoff(release);

    this.busy = true;
    try {
      const connection = await this.deps.getConnection();
      this.set({ connection });
      const decision = decideNetwork(connection, this.state.cellularPolicy, opts.allowCellular);

      if (decision.action === "offline") {
        this.set({ phase: "error", error: "No internet connection. Connect and try again." });
        return;
      }
      if (decision.action === "ask") {
        this.set({ phase: "confirm_cellular", error: null });
        return;
      }
      if (!release.has_file) {
        this.set({ phase: "error", error: "This release has no downloadable file." });
        return;
      }

      this.set({
        phase: connection === "cellular" && !decision.allowCellular ? "waiting_wifi" : "downloading",
        error: null,
        progress: { bytes: 0, total: release.file_size_bytes ?? 0 },
      });

      const resp = await this.deps.requestDownload(release.id);
      if (resp.kind !== "apk" || !resp.sha256) throw new Error("Unexpected response from the update server.");

      const { downloadId } = await this.deps.plugin.startDownload({
        url: resp.url,
        fileName: resp.file_name,
        title: "DuoSpace update",
        description: `Version ${release.version_name}`,
        allowCellular: decision.allowCellular,
      });
      this.download = {
        releaseId: release.id,
        downloadId,
        fileName: resp.file_name,
        sha256: resp.sha256,
        versionCode: release.version_code,
        allowCellular: decision.allowCellular,
      };
      await this.deps.store.set(KEY_DOWNLOAD, JSON.stringify(this.download));
      this.startPolling();
    } catch (e) {
      this.set({ phase: "error", error: errMessage(e) });
    } finally {
      this.busy = false;
    }
  }

  private async handoff(release: ReleaseInfo): Promise<void> {
    this.busy = true;
    this.set({ phase: "handoff", error: null });
    try {
      const resp = await this.deps.requestDownload(release.id);
      this.deps.openUrl(resp.url);
      this.set({ phase: "available" });
    } catch (e) {
      this.set({ phase: "error", error: errMessage(e) });
    } finally {
      this.busy = false;
    }
  }

  private startPolling(): void {
    this.stopPolling();
    void this.tick();
    this.pollTimer = setInterval(() => void this.tick(), this.deps.pollIntervalMs ?? 800);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async tick(): Promise<void> {
    const dl = this.download;
    if (!dl) {
      this.stopPolling();
      return;
    }
    let st;
    try {
      st = await this.deps.plugin.getDownloadStatus({ downloadId: dl.downloadId });
    } catch {
      return; // transient; next tick retries
    }
    const progress = { bytes: st.bytesDownloaded, total: st.totalBytes || this.state.progress.total };

    switch (st.status) {
      case "success":
        this.stopPolling();
        this.set({ phase: "ready", progress: { bytes: progress.total || progress.bytes, total: progress.total } });
        break;
      case "running":
        this.set({ phase: "downloading", progress });
        break;
      case "pending":
      case "paused": {
        const connection = await this.deps.getConnection();
        const waiting = !dl.allowCellular && connection !== "wifi" && connection !== "unknown";
        this.set({ connection, phase: waiting ? "waiting_wifi" : "downloading", progress });
        break;
      }
      case "failed":
        this.stopPolling();
        await this.clearDownload();
        this.set({ phase: "error", error: downloadFailureMessage(st.reasonCode) });
        break;
      case "missing": // cancelled from the system notification
        this.stopPolling();
        await this.clearDownload();
        this.set({ phase: "available", progress: { bytes: 0, total: this.state.release?.file_size_bytes ?? 0 } });
        break;
    }
  }

  private async clearDownload(): Promise<void> {
    this.download = null;
    await this.deps.store.remove(KEY_DOWNLOAD);
  }

  async install(): Promise<void> {
    const dl = this.download;
    if (!dl) return;
    this.set({ phase: "installing", error: null });
    try {
      const res = await this.deps.plugin.installApk({
        fileName: dl.fileName,
        sha256: dl.sha256,
        expectedVersionCode: dl.versionCode,
      });
      if (res.status === "needs_permission") this.set({ phase: "needs_permission" });
    } catch (e) {
      const code = e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "";
      if (code === "INSTALL_FAILED") {
        this.set({ phase: "ready", error: errMessage(e) });
      } else {
        // The native side already deleted a file that failed verification.
        await this.clearDownload();
        this.set({ phase: "error", error: errMessage(e) });
      }
    }
  }

  async openInstallSettings(): Promise<void> {
    try {
      await this.deps.plugin.openInstallSettings();
    } catch (e) {
      this.set({ error: errMessage(e) });
    }
  }

  async cancel(): Promise<void> {
    this.stopPolling();
    const dl = this.download;
    if (dl) {
      try {
        await this.deps.plugin.cancelDownload({ downloadId: dl.downloadId });
      } catch {
        /* already gone */
      }
    }
    await this.clearDownload();
    this.set({
      phase: this.state.release ? "available" : "idle",
      progress: { bytes: 0, total: this.state.release?.file_size_bytes ?? 0 },
    });
  }

  async dismiss(): Promise<void> {
    const r = this.state.release;
    if (!r || r.mandatory) return;
    await this.deps.store.set(KEY_DISMISSED, JSON.stringify({ code: r.version_code, at: this.deps.now() }));
    this.set({ dismissed: true });
  }

  /** Re-show the prompt on demand (Settings -> "Update"). */
  undismiss(): void {
    this.set({ dismissed: false });
  }

  async setCellularPolicy(policy: CellularPolicy): Promise<void> {
    await this.deps.store.set(KEY_POLICY, policy);
    this.set({ cellularPolicy: policy });
  }

  /** Call whenever the app returns to the foreground. */
  async handleResume(): Promise<void> {
    if (!this.state.supported) return;
    if (this.state.phase === "needs_permission") {
      await this.install(); // the user may have just granted "install unknown apps"
    } else if (this.state.phase === "installing") {
      this.set({ phase: "ready" }); // installer was cancelled / dismissed
    } else if (
      !ACTIVE.has(this.state.phase) &&
      (this.state.lastCheckedAt === null || this.deps.now() - this.state.lastCheckedAt > RECHECK_ON_RESUME_MS)
    ) {
      await this.check({ silent: true });
    }
  }
}

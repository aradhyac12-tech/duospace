/**
 * DuospaceAppUpdate — Android in-app APK update (sideloaded builds).
 *
 * - Downloads go through Android's DownloadManager, so the OS enforces the
 *   network policy (`allowCellular: false` => Wi-Fi only; the job simply waits
 *   for Wi-Fi), resumes after drops and keeps going if the app is killed.
 * - `installApk` is the ONLY path to the installer and refuses unless the file
 *   matches the expected SHA-256, is this app's package, carries exactly the
 *   expected versionCode, is strictly newer than what is installed and (API 28+)
 *   is signed by the same certificate. The OS enforces signing again at install.
 * - No iOS implementation. iOS OTA install is an itms-services link opened from
 *   JS; every method rejects as unimplemented off Android.
 */

export type DownloadState = "pending" | "running" | "paused" | "success" | "failed" | "missing";

export interface StartDownloadOptions {
  /** HTTPS URL (signed, short-lived). */
  url: string;
  /** Plain file name, `[A-Za-z0-9._-]+.apk`; stored in the app's private Downloads dir. */
  fileName: string;
  title: string;
  description?: string;
  /** false => Wi-Fi only (non-metered). true => Wi-Fi or mobile data (never roaming). */
  allowCellular: boolean;
}

export interface DownloadStatus {
  status: DownloadState;
  bytesDownloaded: number;
  totalBytes: number;
  /** Paused because the allowed network (Wi-Fi) is not available. */
  waitingForWifi?: boolean;
  /** DownloadManager COLUMN_REASON: an HTTP status for `failed` (e.g. 403 expired URL) or an ERROR_* code. */
  reasonCode?: number;
}

export interface InstallApkOptions {
  fileName: string;
  /** Lower-case hex SHA-256 of the file as published. */
  sha256: string;
  /** The release's versionCode; the archive must carry exactly this. */
  expectedVersionCode: number;
}

export type InstallApkResult =
  | { status: "started" }
  /** "Install unknown apps" is off for DuoSpace; call openInstallSettings(). */
  | { status: "needs_permission" };

export interface DuospaceAppUpdatePlugin {
  startDownload(options: StartDownloadOptions): Promise<{ downloadId: string }>;
  getDownloadStatus(options: { downloadId: string }): Promise<DownloadStatus>;
  cancelDownload(options: { downloadId: string }): Promise<void>;
  /**
   * Rejects with code: FILE_MISSING, HASH_MISMATCH (file deleted), INVALID_APK,
   * WRONG_PACKAGE, VERSION_MISMATCH, NOT_NEWER, SIGNATURE_MISMATCH (all delete
   * the file), INSTALL_FAILED.
   */
  installApk(options: InstallApkOptions): Promise<InstallApkResult>;
  openInstallSettings(): Promise<void>;
  /** Package name of the installing store, e.g. "com.android.vending", or null (sideloaded/adb). */
  getInstallSource(): Promise<{ installer: string | null }>;
  /** Delete previously downloaded update files. */
  cleanup(): Promise<void>;
}

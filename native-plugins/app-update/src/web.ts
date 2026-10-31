/**
 * Web / iOS fallback for DuospaceAppUpdate. Not a fake: every method rejects,
 * so a caller that forgets to gate on Android fails loudly instead of
 * pretending an update was installed.
 */
import { WebPlugin } from "@capacitor/core";
import type {
  DuospaceAppUpdatePlugin,
  DownloadStatus,
  InstallApkOptions,
  InstallApkResult,
  StartDownloadOptions,
} from "./definitions";

export class AppUpdateWeb extends WebPlugin implements DuospaceAppUpdatePlugin {
  private notAndroid(): never {
    throw this.unimplemented("DuospaceAppUpdate is only available on Android.");
  }
  async startDownload(_o: StartDownloadOptions): Promise<{ downloadId: string }> { return this.notAndroid(); }
  async getDownloadStatus(_o: { downloadId: string }): Promise<DownloadStatus> { return this.notAndroid(); }
  async cancelDownload(_o: { downloadId: string }): Promise<void> { return this.notAndroid(); }
  async installApk(_o: InstallApkOptions): Promise<InstallApkResult> { return this.notAndroid(); }
  async openInstallSettings(): Promise<void> { return this.notAndroid(); }
  async getInstallSource(): Promise<{ installer: string | null }> { return this.notAndroid(); }
  async cleanup(): Promise<void> { return this.notAndroid(); }
}
